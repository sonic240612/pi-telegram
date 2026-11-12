/**
 * Outbound mirroring: pi agent events -> Telegram chats.
 *
 * Pi emits raw transcript events; this module decides how much of them the chats see,
 * following the configured detail level:
 *   0  답장만             answers only
 *   1  답장 + 도구 요약   answers + one compact tool summary per turn (default)
 *   2  전체 미러링        full transcript mirror (thinking, tool calls, tool results, usage)
 *
 * Live text is written into a draft message that is edited in place (see draft.ts), which is
 * how the pi terminal renders streaming output. Discrete transcript items become ordinary
 * messages, already chunked to Telegram's limits by the hub.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Hub } from "./hub.ts";
import type { DraftManager } from "./draft.ts";
import {
	draftHtml,
	escapeHtml,
	formatCost,
	formatCount,
	formatDuration,
	mdToHtml,
	redactSecrets,
	resultText,
	summarizeToolCall,
	textFromContent,
	thinkingFromContent,
	toHtmlChunks,
	truncate,
} from "./format.ts";

/** Telegram's typing hint lasts ~5s; refresh a bit before it dies. */
const TYPING_PULSE_MS = 4500;

interface UsageInfo {
	input: number;
	output: number;
	totalTokens: number;
	cost?: number;
}

interface ToolNote {
	name: string;
	detail: string;
	isError: boolean;
	durationMs?: number;
}

interface TurnSummary {
	tools: ToolNote[];
	usage?: UsageInfo;
	durationMs?: number;
}

export class OutboundMirror {
	private readonly hub: Hub;
	private readonly drafts: DraftManager;

	/** Per-chat state for the turn in flight. Chats paired mid-run join from here on. */
	private turns = new Map<number, TurnSummary>();
	/** Tool calls in flight, so the end event can update the note the start event created. */
	private noteRefs = new Map<string, ToolNote[]>();
	/**
	 * pi fires transcript events faster than Telegram can be edited, and every handler is async.
	 * Serialising them keeps the chat readable: an answer never lands after the tool summary of
	 * the turn that produced it.
	 */
	private queue: Promise<void> = Promise.resolve();
	/**
	 * Telegram shows "입력 중…" for about five seconds after a `sendChatAction`, so while pi is
	 * working we pulse it. Without that the chat looks dead for the whole run.
	 */
	private typingTimer?: ReturnType<typeof setTimeout>;

	constructor(hub: Hub, drafts: DraftManager) {
		this.hub = hub;
		this.drafts = drafts;
	}

	/** Subscribe to every pi event this module cares about. */
	register(pi: ExtensionAPI): void {
		pi.on("agent_start", () => {
			this.turns = new Map();
			this.hub.setWorkingNotice("⏳ pi 작업 중");
			this.startTyping();
		});
		pi.on("agent_end", (event) => {
			this.hub.setWorkingNotice(undefined);
			this.noteRefs.clear();
			this.stopTyping();
			this.enqueue(() => this.handleAgentEnd(event.messages ?? []));
		});
		pi.on("agent_settled", (event) => {
			if (event.aborted) this.enqueue(() => this.sendHtmlAll("⛔ <i>중단했어요.</i>"));
			this.turns = new Map();
			this.stopTyping();
		});
		pi.on("turn_start", () => {
			this.turns = new Map();
			for (const chatId of this.chats()) this.turns.set(chatId, { tools: [] });
		});
		pi.on("turn_end", (event) => this.enqueue(() => this.handleTurnEnd(event.message)));
		pi.on("message_start", (event) => this.enqueue(() => this.handleMessageStart(event.message)));
		pi.on("message_update", (event) => this.enqueue(() => this.handleMessageUpdate(event.message)));
		pi.on("message_end", (event) => this.enqueue(() => this.handleMessageEnd(event.message)));
		pi.on("tool_execution_start", (event) => this.enqueue(() => this.handleToolStart(event.toolCallId, event.toolName, event.args, event.parentToolCallId)));
		pi.on("tool_execution_end", (event) =>
			this.enqueue(() => this.handleToolEnd(event.toolCallId, event.toolName, event.result, event.isError, event.durationMs, event.parentToolCallId)),
		);
	}

	/** Run `task` after everything already queued; a failure is reported, never silently dropped. */
	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((error: unknown) => {
			this.hub.reportError("mirror", error);
		});
	}

	/** Wait for everything mirrored so far to be delivered. */
	async settled(): Promise<void> {
		await this.queue;
		this.stopTyping();
	}

	/**
	 * Keep Telegram's "입력 중…" hint alive while pi works — it expires after ~5s on its own, so it
	 * has to be refreshed. Without it a long run looks like the bridge died.
	 */
	private startTyping(): void {
		if (this.typingTimer) return;
		const pulse = () => {
			this.typingTimer = undefined;
			for (const chatId of this.chats()) this.hub.typing(chatId);
			this.typingTimer = setTimeout(pulse, TYPING_PULSE_MS);
			this.typingTimer.unref?.();
		};
		pulse();
	}

	/** Stop the "입력 중…" pulses (called when a run ends or the bridge goes away). */
	stopTyping(): void {
		if (this.typingTimer) clearTimeout(this.typingTimer);
		this.typingTimer = undefined;
	}

	// ------------------------------------------------------------------ internals

	private chats(): number[] {
		return this.hub.chats();
	}

	private verbosity(): 0 | 1 | 2 {
		return this.hub.verbosity();
	}

	// ---- assistant messages: answers, streamed with a live draft ----

	private async handleMessageStart(message: unknown): Promise<void> {
		if (roleOf(message) !== "assistant") return;
		if (!this.hub.cfg.streaming) return;
		for (const chatId of this.chats()) {
			if (!this.turns.has(chatId)) this.turns.set(chatId, { tools: [] });
			await this.drafts.update(chatId, "<i>⏳ 생각 중…</i>");
		}
	}

	private async handleMessageUpdate(message: unknown): Promise<void> {
		if (roleOf(message) !== "assistant" || !this.hub.cfg.streaming) return;
		const text = textFromContent((message as { content?: unknown }).content);
		if (!text.trim()) return;
		const html = draftHtml(text);
		for (const chatId of this.chats()) await this.drafts.update(chatId, html);
	}

	/**
	 * A run can end with nothing to show: the provider call threw before any message existed (no
	 * API key, bad request) and pi prints that only in its terminal. Telegram would just wait, so
	 * report the anomaly. Runs that did visible work (answer, failure, tool results) are skipped.
	 */
	private async handleAgentEnd(messages: readonly unknown[]): Promise<void> {
		const produced = (Array.isArray(messages) ? messages : []).some((entry) => {
			const record = entry as { role?: string; stopReason?: string; content?: unknown };
			if (record.role === "toolResult") return true;
			if (record.role !== "assistant") return false;
			if (record.stopReason && record.stopReason !== "stop") return true; // surfaced as a failure line
			return textFromContent(record.content).trim().length > 0;
		});
		if (produced) return;
		await this.sendHtmlAll("⚠️ <i>pi가 답 없이 실행을 끝냈어요 — 모델·provider 설정을 확인하세요 (/status).</i>");
	}

	private async handleMessageEnd(message: unknown): Promise<void> {
		const role = roleOf(message);
		const verbosity = this.verbosity();

		if (role === "toolResult") return; // mirrored through tool_execution_end instead
		const text = textFromContent((message as { content?: unknown }).content);
		const thinking = thinkingFromContent((message as { content?: unknown }).content);

		if (role === "user" || role === "custom" || role === "bashExecution") {
			// prompts typed in Telegram are already on screen — never echo them back.
			if (verbosity === 2 && text.trim() && !this.hub.wasTelegramInput(text)) {
				await this.sendHtmlAll(`<blockquote>🧑 ${mdToHtml(truncate(text, 3000))}</blockquote>`);
			}
			return;
		}
		if (role !== "assistant") return;

		if (verbosity === 2 && thinking.trim()) {
			await this.sendHtmlAll(`<blockquote>💭 ${escapeHtml(truncate(thinking, 2500))}</blockquote>`);
		}
		// A failed model call must never look like silence: pi shows it in the terminal, so do we.
		const failure = failureLine(message);
		if (failure) {
			for (const chatId of this.chats()) await this.drafts.discard(chatId);
			await this.sendHtmlAll(failure);
			return;
		}
		if (!text.trim()) {
			for (const chatId of this.chats()) await this.drafts.discard(chatId);
			return;
		}
		for (const chatId of this.chats()) await this.deliverAnswer(chatId, text);
		if (verbosity === 2) {
			const footer = usageLine(readUsage((message as { usage?: unknown }).usage), (message as { durationMs?: number }).durationMs);
			if (footer) await this.sendHtmlAll(`<i>${escapeHtml(footer)}</i>`);
		}
	}

	/**
	 * Deliver a finished answer: reuse the live draft when the whole answer fits in one message.
	 * Otherwise keep the draft as the first part (it is already on screen and may be mid-stream) and
	 * send the remaining chunks as new messages — nothing the user can see is ever thrown away.
	 */
	private async deliverAnswer(chatId: number, markdown: string): Promise<void> {
		const chunks = toHtmlChunks(markdown);
		const first = chunks[0] ?? "";
		const finalized = await this.drafts.finalize(chatId, first);
		if (finalized === undefined) await this.sendHtml(chatId, first);
		for (const chunk of chunks.slice(1)) await this.sendHtml(chatId, chunk);
	}

	// ---- tool calls ----

	private async handleToolStart(toolCallId: string, toolName: string, args: unknown, parentToolCallId?: string): Promise<void> {
		if (parentToolCallId) return; // nested calls are already inside the parent's output
		const detail = summarizeToolCall(toolName, args);
		this.hub.setWorkingNotice(`⚙️ ${toolName} ${truncate(detail, 60)}`);
		const notes: ToolNote[] = [];
		for (const chatId of this.chats()) {
			const turn = this.turns.get(chatId) ?? this.newTurn(chatId);
			const note: ToolNote = { name: toolName, detail, isError: false };
			turn.tools.push(note);
			notes.push(note);
			if (this.verbosity() === 2) await this.sendHtml(chatId, `${iconFor(toolName)} <code>${escapeHtml(toolName)}</code> ${escapeHtml(truncate(detail, 700))}`);
		}
		this.noteRefs.set(toolCallId, notes);
	}

	private async handleToolEnd(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
		durationMs: number | undefined,
		parentToolCallId?: string,
	): Promise<void> {
		if (parentToolCallId) return;
		const notes = this.noteRefs.get(toolCallId);
		this.noteRefs.delete(toolCallId);
		const detail = notes?.[0]?.detail ?? summarizeToolCall(toolName, undefined);
		for (const note of notes ?? [{ name: toolName, detail, isError: false }]) {
			note.isError = isError;
			note.durationMs = durationMs;
		}
		for (const chatId of this.chats()) {
			if (this.verbosity() !== 2) continue;
			const header = `${isError ? "❌" : iconFor(toolName)} <code>${escapeHtml(toolName)}</code> ${escapeHtml(truncate(detail, 300))}${durationMs !== undefined ? ` <i>(${escapeHtml(formatDuration(durationMs))})</i>` : ""}`;
			const output = resultText(result);
			await this.sendHtml(chatId, output ? `${header}\n<pre>${escapeHtml(truncate(output, 2500))}</pre>` : header);
		}
	}

	// ---- turn boundary: the compact summary that replaces pi's inline tool lines ----

	private async handleTurnEnd(message: unknown): Promise<void> {
		const usage = readUsage((message as { usage?: unknown } | undefined)?.usage);
		const durationMs = (message as { durationMs?: number } | undefined)?.durationMs;
		const verbosity = this.verbosity();
		for (const [chatId, turn] of this.turns) {
			if (usage) turn.usage = usage;
			if (durationMs) turn.durationMs = durationMs;
			if (!turn.tools.length) continue;
			if (verbosity === 1) await this.sendTurnSummary(chatId, turn);
			if (verbosity === 2) {
				const bits: string[] = [`도구 ${turn.tools.length}회`];
				const footer = usageLine(turn.usage, turn.durationMs);
				if (footer) bits.push(footer);
				await this.sendHtml(chatId, `<i>${escapeHtml(bits.join(" · "))}</i>`);
			}
		}
		this.turns = new Map();
	}

	private async sendTurnSummary(chatId: number, turn: TurnSummary): Promise<void> {
		const footer = usageLine(turn.usage, turn.durationMs);
		const head = footer ? `🔧 <b>이번 턴</b> · ${turn.tools.length}회 <i>${escapeHtml(footer)}</i>` : `🔧 <b>이번 턴</b> · ${turn.tools.length}회`;
		const lines = turn.tools.map(
			(tool) => `${tool.isError ? "❌" : iconFor(tool.name)} <code>${escapeHtml(tool.name)}</code> ${escapeHtml(truncate(tool.detail, 160))}${tool.durationMs !== undefined ? ` <i>${escapeHtml(formatCount(tool.durationMs / 1000))}s</i>` : ""}`,
		);
		await this.sendHtml(chatId, [head, ...lines].join("\n"));
	}

	private newTurn(chatId: number): TurnSummary {
		const turn: TurnSummary = { tools: [] };
		this.turns.set(chatId, turn);
		return turn;
	}

	// ---- sending ----

	private async sendHtml(chatId: number, html: string): Promise<void> {
		try {
			await this.hub.send(chatId, html, { markdown: false });
		} catch {
			/* ignore */
		}
	}

	private async sendHtmlAll(html: string): Promise<void> {
		for (const chatId of this.chats()) await this.sendHtml(chatId, html);
	}
}

// ---------------------------------------------------------------- helpers

function roleOf(message: unknown): string {
	return String((message as { role?: string } | undefined)?.role ?? "");
}

/**
 * A model call that ended badly (bad key, rate limit, overflow, truncated at max tokens).
 * pi prints these in the terminal; without them Telegram just looks dead, so mirror them.
 */
function failureLine(message: unknown): string | undefined {
	const record = message as { stopReason?: string; errorMessage?: string } | undefined;
	if (!record || roleOf(record) !== "assistant") return undefined;
	const error = typeof record.errorMessage === "string" ? record.errorMessage.trim() : "";
	if (record.stopReason === "error" || error) {
		const detail = error || "알 수 없는 오류로 모델 응답이 끊겼어요.";
		return `❌ <i>${escapeHtml(truncate(redactSecrets(detail), 900))}</i>`;
	}
	if (record.stopReason === "length") {
		return "⚠️ <i>max tokens에 도달해서 답이 잘렸어요. 터미널에서 /model 로 context window 큰 모델을 고르거나 답을 나눠 요청해요.</i>";
	}
	return undefined;
}

function readUsage(usage: unknown): UsageInfo | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const value = usage as { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
	if (value.input === undefined && value.output === undefined && value.totalTokens === undefined) return undefined;
	return {
		input: value.input ?? 0,
		output: value.output ?? 0,
		totalTokens: value.totalTokens ?? 0,
		cost: typeof value.cost?.total === "number" ? value.cost.total : undefined,
	};
}

function usageLine(usage: UsageInfo | undefined, durationMs?: number): string {
	const bits: string[] = [];
	if (usage) {
		bits.push(`↑${formatCount(usage.input)} ↓${formatCount(usage.output)} tok`);
		const cost = formatCost(usage.cost);
		if (cost) bits.push(cost);
	}
	if (durationMs !== undefined) bits.push(formatDuration(durationMs));
	return bits.join(" · ");
}

function iconFor(name: string): string {
	if (name === "bash") return "💻";
	if (name === "edit" || name === "multiedit") return "✏️";
	if (name === "write") return "📝";
	if (name === "read") return "📖";
	if (name === "grep" || name === "glob") return "🔎";
	if (name === "task" || name === "subagent") return "🤖";
	if (name === "web_search" || name === "webfetch" || name === "web_fetch") return "🌐";
	if (name === "todo") return "🗒️";
	if (name === "telegram_send" || name === "telegram_ask") return "📨";
	return "•";
}
