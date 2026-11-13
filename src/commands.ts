/**
 * Telegram-side command layer: pi commands re-expressed for a chat window.
 *
 * pi's built-in slash commands live in the terminal, so the useful ones
 * (/model, /thinking, /compact, /new, /resume, /fork, /tree, /rename, /reload)
 * are re-implemented on top of the extension API. Extension, skill, and prompt
 * template commands are passed straight through with `expandPromptTemplates`.
 */
import type { CallbackActionKind, CallbackEntry, CallbackResult, Hub, ListSpec, SendOptions } from "./hub.ts";
import { credentialHits, escapeHtml, formatBytes, formatCount, formatDuration, inlineCode, redactSecrets, tgDebug, truncate } from "./format.ts";
import { goalCardHtml, goalStatusLabel } from "./goal.ts";
import type { TgInlineKeyboardButton } from "./telegram.ts";

export interface CommandInvocation {
	chatId: number;
	userId: number;
	/** Command name without the leading slash, lower-cased. */
	command: string;
	args: string;
	raw: string;
}

export interface MenuEntry {
	command: string;
	description: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Registered with Telegram's command menu (names must be [a-z0-9_]). */
export const TELEGRAM_MENU: MenuEntry[] = [
	{ command: "help", description: "명령어 목록 / commands" },
	{ command: "status", description: "세션·모델 상태 / session status" },
	{ command: "model", description: "모델 선택 / select model" },
	{ command: "thinking", description: "thinking 레벨 / thinking level" },
	{ command: "compact", description: "컨텍스트 압축 / compact" },
	{ command: "new", description: "새 세션 / new session" },
	{ command: "resume", description: "세션 불러오기 / resume" },
	{ command: "fork", description: "이전 프롬프트에서 포크 / fork" },
	{ command: "tree", description: "세션 트리 이동 / navigate tree" },
	{ command: "rename", description: "세션 이름 / rename session" },
	{ command: "usage", description: "컨텍스트 사용량 / context usage" },
	{ command: "tools", description: "도구 켜기끄기 / toggle tools" },
	{ command: "commands", description: "pi 명령어 / pi commands" },
	{ command: "skills", description: "스킬 실행 / run a skill" },
	{ command: "abort", description: "실행 중단 / abort" },
	{ command: "steer", description: "실행 중 지시 / steer" },
	{ command: "queue", description: "끝난 후 전달 / follow-up" },
	{ command: "bash", description: "셸 명령 / run shell" },
	{ command: "export", description: "세션 파일 전송 / send session file" },
	{ command: "verbose", description: "표시 상세도 / detail level" },
	{ command: "stream", description: "실시간 초안 / live draft" },
	{ command: "tg", description: "브리지 관리 / bridge admin" },
	{ command: "pair", description: "채팅 허용 / pair chat" },
	{ command: "ping", description: "연결 확인 / connectivity" },
	{ command: "stats", description: "지연 통계 / latency stats" },
	{ command: "chats", description: "페어링된 채팅 / paired chats" },
	{ command: "pending", description: "승인 대기 채팅 / pending chats" },
	{ command: "unpair", description: "채팅 차단 / revoke a chat" },
	{ command: "restart", description: "브리지 재시작 / restart bridge" },
	{ command: "menu", description: "버튼 메뉴 / button menu" },
	{ command: "start", description: "처음 시작 / start here" },
];

/** Built-ins that only make sense in the terminal. */
/**
 * Keyboard labels are one line and Telegram hard-caps them at 64 characters, so clip here instead
 * of reusing truncate(): its "… (n more chars)" note contains a newline and makes the string
 * longer, which is exactly what makes an entire keyboard fail to send.
 */
function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

const TERMINAL_ONLY = ["settings", "scoped-models", "import", "share", "bug", "copy", "hotkeys", "changelog", "clone", "trust", "login", "logout", "init", "yolo", "autocompile"];

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

interface ListItem {
	label: string;
	kind: CallbackActionKind;
	value: string;
}

interface ListRender {
	title: string;
	items: ListItem[];
	perPage: number;
	columns: number;
	note?: string;
}

export class CommandLayer {
	readonly hub: Hub;

	constructor(hub: Hub) {
		this.hub = hub;
	}

	async handle(inv: CommandInvocation): Promise<void> {
		const chatId = inv.chatId;
		switch (inv.command) {
			case "start":
			case "help":
				return this.help(chatId);
			case "menu":
				return this.rootMenu(chatId);
			case "ping":
				return this.ping(chatId);
			case "status":
			case "session":
				return this.status(chatId);
			case "model":
			case "models":
				return this.model(chatId, inv.args);
			case "thinking":
				return this.thinking(chatId, inv.args);
			case "compact":
				return this.compact(chatId, inv.args);
			case "new":
				return this.newSession(chatId);
			case "resume":
				return this.renderList(chatId, { list: "resume", args: inv.args, page: 0 });
			case "fork":
				return this.renderList(chatId, { list: "fork", args: inv.args, page: 0 });
			case "tree":
				return this.renderList(chatId, { list: "tree", args: inv.args, page: 0 });
			case "rename":
			case "name":
				return this.rename(chatId, inv.args);
			case "usage":
				return this.usage(chatId);
			case "tools":
				return this.tools(chatId, inv.args);
			case "commands":
			case "prompts":
				return this.renderList(chatId, { list: "commands", args: inv.args, page: 0 });
			case "skills":
				return this.renderList(chatId, { list: "skills", args: inv.args, page: 0 });
			case "abort":
			case "stop":
			case "cancel":
				return this.abort(chatId);
			case "steer":
				return this.deliver(chatId, inv.args, "steer");
			case "queue":
			case "followup":
				return this.deliver(chatId, inv.args, "followUp");
			case "bash":
				return this.bash(chatId, inv.args);
			case "export":
				return this.exportSession(chatId);
			case "verbose":
				return this.verbose(chatId, inv.args);
			case "stream":
				return this.stream(chatId, inv.args);
			case "reload":
				return this.reload(chatId);
			case "tg":
				return this.bridgeCommand(chatId, inv.args);
			case "pair":
				return this.pair(chatId);
			case "chats":
				return this.chats(chatId);
			case "stats":
				return this.tgStats(chatId);
			case "pending":
				return this.bridgeCommand(chatId, "pending");
			case "unpair":
				return this.bridgeCommand(chatId, `unpair ${inv.args}`.trim());
			case "restart":
				return this.bridgeCommand(chatId, "restart");
			default:
				return this.passThrough(chatId, inv);
		}
	}

	// ---------------------------------------------------------------- text commands

	private async help(chatId: number): Promise<void> {
		const sections: [string, string][] = [
			["세션", "/new · /resume [검색어] · /fork [메시지] · /tree · /rename <이름> · /export · /compact [지시]"],
			["모델·도구", "/model [이름·검색어] · /thinking [off|minimal|low|medium|high] · /tools [list|on|off|reset|<이름>]"],
			["실행 제어", "/abort · /steer <메시지> · /queue <메시지> · /bash <셸 명령>"],
			["상태·표시", "/status · /usage · /commands · /skills · /verbose [0|1|2] · /stream [on|off] · /ping · /stats"],
			["브리지", "/pair · /chats · /pending · /unpair <채팅id> · /restart · /tg status|pair|unpair|chats|pending|restart|verbose|stream|stats|menu|redact|goal"],
		];
		const body = sections.map(([title, list]) => `<b>${title}</b>\n${list}`).join("\n\n");
		const notes = [
			"",
			"<i>일반 텍스트는 그대로 pi 프롬프트, 이미지·PDF·코드 파일은 첨부로 전달돼요.</i>",
			"<i>pi 확장·스킬·프롬프트 템플릿 명령도 그대로 동작: /review, /skill:pdf, /mytemplate …</i>",
			"<i>자동완성에 안 보이는 명령도 그대로 쳐면 동작해요. 자동완성 목록이 이상하면 /tg menu</i>",
		];
		const rows: TgInlineKeyboardButton[][] = [
			["model", "thinking", "tools"].map((name) => this.menuButton(chatId, `🧠 ${name}`, name)),
			["commands", "skills", "resume"].map((name) => this.menuButton(chatId, `⌨️ ${name}`, name)),
			["status", "usage", "verbose 2"].map((name) => this.menuButton(chatId, `📊 ${name.trim()}`, name)),
		];
		await this.say(chatId, `<b>pi-telegram</b>\n\n${body}${notes.join("\n")}`, { keyboard: rows });
	}

	private async rootMenu(chatId: number): Promise<void> {
		const rows: TgInlineKeyboardButton[][] = [
			["model", "thinking", "tools"].map((name) => this.menuButton(chatId, name, name)),
			["new", "resume", "fork"].map((name) => this.menuButton(chatId, name, name)),
			["status", "usage", "abort"].map((name) => this.menuButton(chatId, name, name)),
		];
		await this.say(chatId, "<b>pi-telegram menu</b>", { keyboard: rows });
	}

	private async ping(chatId: number): Promise<void> {
		const ctx = this.hub.tryPiContext();
		await this.say(
			chatId,
			`🏓 <b>pong</b>\nbot ${inlineCode(this.hub.botName())}\npi ${inlineCode(ctx ? "connected" : "detached")}\nchats ${inlineCode(String(this.hub.chats().length))}\nuptime ${inlineCode(formatDuration(this.hub.uptimeMs()))} · ${inlineCode(this.hub.isIdle() ? "idle" : "running")}`,
		);
	}

	private async status(chatId: number): Promise<void> {
		const info = this.hub.sessionInfo();
		const usage = this.hub.contextUsage();
		const active = this.hub.listTools().filter((tool) => tool.active).map((tool) => tool.name);
		const lines = [
			`🤖 <b>${escapeHtml(this.hub.botName())}</b> ↔ pi`,
			`model ${inlineCode(this.hub.currentModelKey() ?? "none")}`,
			`thinking ${inlineCode(this.hub.thinkingLevel())}`,
			`session ${inlineCode(this.hub.sessionName() ?? info.id)}`,
			`file ${inlineCode(info.file ?? "(unsaved)")}`,
			`cwd ${inlineCode(info.cwd)}`,
			`entries ${inlineCode(String(info.entries))} · messages ${inlineCode(String(info.messages))}`,
			`context ${inlineCode(usage?.percent != null ? `${usage.percent.toFixed(1)}%` : usage?.tokens != null ? `${formatCount(usage.tokens)} tok` : "unknown")}`,
			`tools ${inlineCode(active.join(", ") || "none")}`,
			`detail ${inlineCode(String(this.hub.verbosity()))} · drafts ${inlineCode(this.hub.cfg.streaming ? "on" : "off")} · ${inlineCode(this.hub.isIdle() ? "idle" : "running")}`,
		];
		const goal = this.hub.goalState().goal;
		// A goal is the one thing /status cannot show from pi's own state, and the one thing a phone
		// user most needs to see while pi runs unattended.
		if (goal) {
			lines.push(
				`goal ${goalStatusLabel(goal.status)} ${inlineCode(truncate(goal.id, 24))}${goal.tasksTotal ? ` · ${goal.tasksDone}/${goal.tasksTotal}` : ""} · ${formatCount(goal.tokensUsed)} tok <i>(/tg goal)</i>`,
			);
		}
		await this.say(chatId, lines.join("\n"));
	}

	private async model(chatId: number, args: string): Promise<void> {
		const query = args.trim();
		if (query) {
			// A provider such as openrouter carries hundreds of models, so a typed reference searches
			// everything pi knows about — not only the handful it considers "available".
			const pool = this.hub.searchModels(query, 400);
			// `openrouter/anthropic/claude-sonnet-4.5` or `nvidia/nemotron-3.5-super-vl:free` typed in full
			// is an instruction, not a search: apply it instead of showing a keyboard.
			const exact = pool.find((model) => model.id.toLowerCase() === query.toLowerCase() || model.key.toLowerCase() === query.toLowerCase());
			if (exact) return this.applyModelRef(chatId, exact.key, query);
			const matches = pool.slice(0, 80);
			if (matches.length === 1) return this.applyModelRef(chatId, matches[0].key, query);
			if (!matches.length) {
				if (query.includes("/")) {
					// pi has never seen this id, but a provider can still resolve it (known provider, or an
					// aggregator whose ids embed the manufacturer): use the provider's shape as-is.
					return this.applyModelRef(chatId, query);
				}
				await this.say(chatId, `⚠️ 일치하는 모델이 없어요: ${inlineCode(query)}\n목록은 ${inlineCode("/model")}, 특정 모델은 ${inlineCode("provider/id")}를 정확히 입력하면 그대로 사용해요.`);
				return;
			}
			return this.renderList(chatId, { list: "model", args: query, page: 0 });
		}
		const curated = this.hub.listModels();
		if (curated.length > 40) {
			// paging through 400 usable ids is useless — ask which provider, or for a search term
			return this.renderList(chatId, { list: "model:providers", args: "", page: 0 });
		}
		await this.renderList(chatId, { list: "model", args: query, page: 0 });
	}

	private async applyModelRef(chatId: number, key: string, typed?: string): Promise<void> {
		const result = await this.hub.setModelByKey(key);
		if (!result.ok) {
			await this.say(chatId, `⚠️ 모델 변경 실패: ${escapeHtml(result.error ?? "unknown")}`);
			return;
		}
		const applied = result.resolved ?? key;
		const asked = (typed ?? key).toLowerCase();
		const renamed = applied.toLowerCase() !== asked ? `\n· ${inlineCode(typed ?? key)} → ${inlineCode(applied)}로 해석했어요.` : "";
		const note = result.custom ? `\n✨ pi가 처음 보는 id예요 — 같은 provider의 ${inlineCode(result.custom.template)} 설정을 그대로 사용했어요.` : "";
		await this.say(chatId, `🔀 model → ${inlineCode(applied)}${renamed}${note}`);
	}

	private async thinking(chatId: number, args: string): Promise<void> {
		const level = args.trim().toLowerCase();
		if (level) {
			if (!THINKING_LEVELS.includes(level)) {
				await this.say(chatId, `⚠️ 레벨 선택: ${THINKING_LEVELS.map((entry) => inlineCode(entry)).join(" ")}`);
				return;
			}
			const result = this.hub.setThinkingLevel(level);
			await this.say(chatId, result.ok ? `🧠 thinking → ${inlineCode(level)}` : `⚠️ thinking 변경 실패: ${escapeHtml(result.error ?? "unknown")}`);
			return;
		}
		await this.renderThinking(chatId);
	}

	private async renderThinking(chatId: number): Promise<void> {
		const current = this.hub.thinkingLevel();
		const rows = [THINKING_LEVELS.map((level) => ({ text: `${level === current ? "● " : ""}${level}`, callback_data: this.hub.createToken({ kind: "thinking:pick", value: level }, chatId) }))];
		await this.say(chatId, `<b>thinking level</b> · current ${inlineCode(current)}\n모델이 지원하지 않는 레벨은 자동으로 제한됩니다.`, { keyboard: rows });
	}

	private async compact(chatId: number, args: string): Promise<void> {
		const result = this.hub.compactRun(args.trim() || undefined);
		await this.say(chatId, result.ok ? `🗜️ 압축 시작${args.trim() ? ` · ${inlineCode(truncate(args.trim(), 120))}` : ""}` : `⚠️ compact 실패: ${escapeHtml(result.error ?? "unknown")}`);
	}

	private async newSession(chatId: number): Promise<void> {
		await this.say(chatId, "🆕 새 세션 여는 중…");
		// /new disposes the pi session and re-creates this extension, so this instance cannot confirm;
		// the notice is queued for the bridge instance that comes back up.
		const notice = this.hub.notifyAfterRestart("🆕 <b>새 세션</b>이 열렸어요. 여기서 이어서하면 돼요.");
		try {
			await this.hub.withCommandContext(async (ctx) => {
				await ctx.newSession();
			});
			this.hub.clearPendingNotice(notice);
			await this.say(chatId, "✅ 새 세션이 열렸어요.");
		} catch (error) {
			this.hub.clearPendingNotice(notice);
			await this.quietSay(chatId, `⚠️ 새 세션 실패: ${escapeHtml(safeError(error))}`);
		}
	}

	private async rename(chatId: number, args: string): Promise<void> {
		const name = args.trim();
		if (!name) {
			await this.say(chatId, `현재 이름 ${inlineCode(this.hub.sessionName() ?? "(none)")}\n사용법: ${inlineCode("/rename 이름")}`);
			return;
		}
		this.hub.setSessionName(name);
		await this.say(chatId, `🏷 이름 → ${inlineCode(name)}`);
	}

	private async usage(chatId: number): Promise<void> {
		const usage = this.hub.contextUsage();
		const info = this.hub.sessionInfo();
		if (!usage) {
			await this.say(chatId, `📊 컨텍스트 사용량을 아직 계산할 수 없어요 (첫 응답 전일 수 있음).\nentries ${inlineCode(String(info.entries))}`);
			return;
		}
		const percent = usage.percent ?? 0;
		const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
		await this.say(
			chatId,
			`📊 ${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${inlineCode(`${percent.toFixed(1)}%`)}\n${inlineCode(`${formatCount(usage.tokens ?? 0)} / ${formatCount(usage.contextWindow)} tokens`)}\n${inlineCode(`entries ${info.entries} · messages ${info.messages}`)}`,
		);
	}

	private async tools(chatId: number, args: string): Promise<void> {
		const query = args.trim();
		if (query) {
			const tools = this.hub.listTools();
			const target = tools.find((tool) => tool.name.toLowerCase() === query.toLowerCase());
			if (!target) {
				await this.say(chatId, `⚠️ 도구 없음: ${inlineCode(query)}`);
				return;
			}
			const active = tools.filter((tool) => tool.active).map((tool) => tool.name);
			const next = target.active ? active.filter((name) => name !== target.name) : [...active, target.name];
			this.hub.setActiveTools(next);
			await this.say(chatId, `🔧 ${inlineCode(target.name)} ${target.active ? "off" : "on"} · active ${next.length}/${tools.length}`);
			return;
		}
		await this.renderList(chatId, { list: "tools", args: "", page: 0 });
	}

	private async abort(chatId: number): Promise<void> {
		if (this.hub.isIdle()) {
			await this.say(chatId, "이미 idle 이에요.");
			return;
		}
		this.hub.abortRun();
		await this.say(chatId, "⏹ 중단 요청 전송.");
	}

	private async deliver(chatId: number, args: string, mode: "steer" | "followUp"): Promise<void> {
		const text = args.trim();
		if (!text) {
			await this.say(chatId, mode === "steer" ? `사용법: ${inlineCode("/steer 메시지")} — 실행 중인 에이전트에게 바로 지시` : `사용법: ${inlineCode("/queue 메시지")} — 실행이 끝난 뒤 전달`);
			return;
		}
		this.hub.noteTelegramInput(text);
		this.hub.sendToPi(text, { deliverAs: mode });
		await this.say(chatId, mode === "steer" ? "🧭 steer로 큐에 넣었어요." : "📮 follow-up으로 큐에 넣었어요.");
	}

	private async bash(chatId: number, args: string): Promise<void> {
		const command = args.trim();
		if (!command) {
			await this.say(chatId, `사용법: ${inlineCode("/bash <command>")}`);
			return;
		}
		await this.say(chatId, `💻 ${inlineCode(truncate(command, 200))}`);
		const result = await this.hub.runShell(command, 120_000);
		let body = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\s+$/g, "");
		// Commands like `curl -H "Authorization: Bearer …"` echo credentials into the log. The terminal
		// keeps them; the Telegram copy of this run is scrubbed unless the chat opted out.
		if (this.hub.cfg.redactBash) body = redactSecrets(body);
		const head = `${result.code === 0 ? "✅" : "❌"} exit ${result.code}${result.truncated ? " · <i>truncated by pi</i>" : ""}${result.killed ? " · <i>killed</i>" : ""}`;
		if (!body.trim()) {
			await this.say(chatId, head);
			return;
		}
		if (body.length > 3000) {
			// Too long for a message: show the head inline and send the whole thing as a file, so
			// nothing is lost the way the terminal would let you scroll back.
			await this.say(chatId, `${head}\n<pre>${escapeHtml(truncate(body, 1200))}</pre>`);
			await this.hub.sendFile(chatId, new TextEncoder().encode(body), `bash-output-${Date.now()}.txt`, `full output · ${formatBytes(body.length)}`);
			return;
		}
		await this.say(chatId, `${head}\n<pre>${escapeHtml(body)}</pre>`);
	}

	private async exportSession(chatId: number): Promise<void> {
		const path = this.hub.sessionFilePath();
		if (!path) {
			await this.say(chatId, "⚠️ 아직 파일로 저장되지 않은 세션이에요.");
			return;
		}
		try {
			const { readFileSync } = await import("node:fs");
			const data = Uint8Array.from(readFileSync(path));
			const name = path.split(/[\\/]/).pop() ?? "session.jsonl";
			// The transcript is a second copy of everything pi handled, tool output included.
			const hits = credentialHits(Buffer.from(data).toString("utf8"));
			const caption = `📦 ${escapeHtml(this.hub.sessionName() ?? this.hub.sessionInfo().id)} · ${formatBytes(data.byteLength)}${hits ? ` · ⚠️ credential처럼 보이는 문자열 ${hits}개` : ""}`;
			await this.hub.sendFile(chatId, data, name, caption);
		} catch (error) {
			await this.say(chatId, `⚠️ export 실패: ${escapeHtml(safeError(error))}`);
		}
	}

	private async verbose(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		const map: Record<string, 0 | 1 | 2> = { "0": 0, "1": 1, "2": 2, off: 0, min: 1, minimal: 1, low: 1, full: 2, max: 2 };
		if (raw) {
			const level = map[raw];
			if (level == null) {
				await this.say(chatId, `사용법: ${inlineCode("/verbose 0|1|2")}\n0 답장만 · 1 답장+도구 요약 · 2 전체 미러링(thinking·결과 원문)`);
				return;
			}
			this.hub.cfg.verbosity = level;
			this.hub.save();
		}
		const labels = ["답장만 (answers only)", "답장 + 도구 요약 (default)", "전체 미러링 (full mirror)"];
		await this.say(chatId, `🔍 detail ${this.hub.verbosity()} — ${labels[this.hub.verbosity()]}`);
	}

	private async stream(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		if (raw === "on" || raw === "off") {
			this.hub.cfg.streaming = raw === "on";
			this.hub.save();
		}
		await this.say(chatId, `✍️ 실시간 초안 ${this.hub.cfg.streaming ? "on" : "off"}`);
	}

	/** How hard the bridge scrubs credentials from the copies it makes for Telegram. */
	private async redact(chatId: number, args: string): Promise<void> {
		const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let scope: "bash" | "transcript" = "bash";
		if (parts[0] === "transcript") {
			scope = "transcript";
			parts.shift();
		} else if (parts[0] === "bash") {
			parts.shift();
		}
		const flag = parts[0];
		if (flag === "on" || flag === "1" || flag === "true" || flag === "off" || flag === "0" || flag === "false") {
			const value = flag === "on" || flag === "1" || flag === "true";
			if (scope === "bash") this.hub.cfg.redactBash = value;
			else this.hub.cfg.redactTranscript = value;
			this.hub.save();
		} else if (flag) {
			await this.say(chatId, `⚠️ usage: ${inlineCode("/tg redact on|off")} 또는 ${inlineCode("/tg redact transcript on|off")}`);
			return;
		}
		await this.say(
			chatId,
			[
				"<b>credential 지우기</b>",
				`· /bash 로그: ${this.hub.cfg.redactBash ? "on" : "off"}`,
				`· 미러링되는 transcript: ${this.hub.cfg.redactTranscript ? "on" : "off"}`,
				"",
				"<i>pi/provider 에러와 브리지 알림은 항상 지워요 — provider가 요청에 쓰인 key를 에러문에 그대로 옮겨 적기 때문이에요. 보낸 key는 지워지지만 메지시 본문은 그대로 남아요.</i>",
				`usage: ${inlineCode("/tg redact on|off")} · ${inlineCode("/tg redact transcript on|off")}`,
			].join("\n"),
			{ markdown: false },
		);
	}

	private async reload(chatId: number): Promise<void> {
		await this.say(chatId, "♻️ pi 리소스 reload 중…");
		try {
			await this.hub.withCommandContext(async (ctx) => {
				await ctx.reload();
			});
			await this.say(chatId, "✅ reload 완료 (브지도 다시 시작됩니다)");
		} catch (error) {
			await this.say(chatId, `⚠️ reload 실패: ${escapeHtml(safeError(error))}`);
		}
	}

	private async bridgeCommand(chatId: number, args: string): Promise<void> {
		const parts = args.trim().split(/\s+/);
		const sub = (parts[0] ?? "").toLowerCase();
		const rest = parts.slice(1).join(" ");
		switch (sub) {
			case "":
			case "status":
				return this.status(chatId);
			case "pair":
				this.hub.pairThisChat(chatId);
				return this.say(chatId, "🔗 이 채팅을 허용 목록에 넣었어요.");
			case "unpair":
			case "leave":
				return this.say(chatId, this.hub.unpairChat(chatId) ? "🔌 허용 목록에서 뺐어요. pi에서 /telegram-pair 로 다시 허용할 수 있어요." : "⚠️ 이미 허용 목록에 없어요.");
			case "chats":
				return this.chats(chatId);
			case "pending": {
				const pending = this.hub.pendingChats();
				return this.say(chatId, pending.length ? `<b>pending</b>\n${pending.map((entry) => `${escapeHtml(entry.label)} → ${inlineCode(entry.code)}`).join("\n")}\npi 터미널에서 ${inlineCode("/telegram-pair <code>")}` : "pending 채팅 없음.");
			}
			case "restart":
				this.hub.restartBridge();
				return this.say(chatId, "🔁 브리지 재시작했어요.");
			case "verbose":
				return this.verbose(chatId, rest);
			case "stream":
				return this.stream(chatId, rest);
			case "redact":
				return this.redact(chatId, rest);
			case "stats":
			case "latency":
				return this.tgStats(chatId);
			case "menu":
				return this.tgMenu(chatId);
			case "goal": {
				// pi-goal-x owns /goal; the phone-side view of the same state lives here.
				const state = this.hub.goalState();
				return this.say(chatId, goalCardHtml(state.goal, state.focus));
			}
			default:
				return this.say(chatId, `사용법: ${inlineCode("/tg status|pair|unpair|chats|pending|restart|verbose|stream|stats|menu|redact|goal")}`);
		}
	}

	/** Where the wait lives: pi thinking, or telegram round-trips. Numbers the user can read on a phone. */
	private async tgStats(chatId: number): Promise<void> {
		const stats = this.hub.bridgeStats();
		const lines = [
			`📊 <b>지연 통계</b> · 연결 후 ${formatDuration(stats.uptimeMs)}`,
			`전송 호출 ${stats.calls}회 · 평균 ${stats.avgMs}ms · 최고 ${stats.maxMs}ms`,
			`폴링 ${stats.polls.count}회 (평균 ${stats.polls.avgHoldMs}ms 대기 — 이건 지연이 아니에요)`,
			`프롬프트 → pi 실행 시작: ${stats.promptToRunMs.length ? stats.promptToRunMs.map((ms) => `${ms}ms`).join(" · ") : "기록 없음"}`,
		];
		if (stats.slow.length) lines.push(`느린 호출: ${stats.slow.map((call) => `${escapeHtml(call.method)} ${call.ms}ms`).join(" · ")}`);
		if (stats.throttled.length) {
			const worst = Math.max(...stats.throttled.map((entry) => entry.retryAfter));
			lines.push(`telegram 속도 제한 ${stats.throttled.length}회 (최장 ${worst}s 대기)`);
		}
		if (stats.menu.shadowed) lines.push(`⚠️ 자동완성 메뉴가 다른 프로그램에 의해 덮어써짐 (등록 ${stats.menu.registered} / 노출 ${stats.menu.served}) → /tg menu`);
		if (stats.avgMs > 1200) lines.push(`<i>전송 왕복이 느려요 — 프록시/네트워크를 확인하세요 (TELEGRAM_API_ROOT로 우회 가능).</i>`);
		return this.say(chatId, lines.join("\n"));
	}

	/** Re-register the "/" menu and say what telegram actually serves — autocomplete lies otherwise. */
	private async tgMenu(chatId: number): Promise<void> {
		const menu = await this.hub.refreshMenu();
		if (!menu.registered) return this.say(chatId, "⚠️ <i>브리지 연결이 끊겨서 메뉴를 등록할 수 없어요. /restart </i>");
		const ours = TELEGRAM_MENU.map((entry) => entry.command);
		const foreign = menu.served.filter((name) => !ours.includes(name));
		const lines = [
			`✅ <b>자동완성 메뉴 등록 완료</b> · ${menu.registered}개 등록 / 텔레그램이 노출 중 ${menu.served}개`,
			menu.shadowed
				? `⚠️ 우리 명령이 목록에 없어요 — 같은 봇 토큰을 쓰는 다른 pi/브리지 프로세스가 있습니다. 그 프로세스를 끈 뒤 /restart 하세요.`
				: `<i>목록이 정상입니다. 자동완성이 갱신되지 않으면 채팅을 다시 여세요.</i>`,
		];
		if (foreign.length) lines.push(`다른 목록에서 온 명령 ${foreign.length}개: ${foreign.slice(0, 12).map((name) => inlineCode(name)).join(" ")}`);
		lines.push(`<i>메뉴에 없어도 명령은 그대로 쳐면 동작해요. 전체 목록은 /help</i>`);
		return this.say(chatId, lines.join("\n"));
	}

	private async pair(chatId: number): Promise<void> {
		this.hub.pairThisChat(chatId);
		await this.say(chatId, "🔗 허용했어요. 이제 텍스트는 그대로 pi 프롬프트가 됩니다.");
	}

	private async chats(chatId: number): Promise<void> {
		const paired = this.hub.pairedChats();
		const rows = paired.map((chat) => ({ text: `⛔ ${clip(chat.label, 24)}`, callback_data: this.hub.createToken({ kind: "chat:unpair", value: String(chat.chatId) }, chatId) }));
		const keyboard: TgInlineKeyboardButton[][] = [];
		for (let index = 0; index < rows.length; index += 2) keyboard.push(rows.slice(index, index + 2));
		await this.say(
			chatId,
			`<b>paired chats</b> · ${paired.length}\n${paired.map((chat) => `${chat.chatId} · ${escapeHtml(chat.label)} · ${new Date(chat.addedAt).toISOString().slice(0, 10)}`).join("\n")}`,
			keyboard.length ? { keyboard } : undefined,
		);
	}

	/** Unknown slash command: run pi's own extension/skill/template command. */
	private async passThrough(chatId: number, inv: CommandInvocation): Promise<void> {
		const name = inv.command;
		const matches = this.hub.listCommands().filter((command) => command.name.toLowerCase() === name);
		if (matches.length) {
			const target = matches[0];
			const rest = inv.args.trim();
			const invocation = `/${target.name}${rest ? ` ${rest}` : ""}`;
			this.hub.noteTelegramInput(invocation);
			this.hub.sendToPi(invocation, { expandPromptTemplates: true });
			await this.say(chatId, `▶️ ${inlineCode(`/${target.name}`)} 실행 (${target.source}).`);
			return;
		}
		if (TERMINAL_ONLY.includes(name)) {
			await this.say(chatId, `ℹ️ /${name} 은 pi 터미널 전용이에요. Telegram에서는 ${inlineCode("/model /thinking /compact /new /resume /fork /tree /rename /reload /bash /usage")} 를 쓸 수 있어요.`);
			return;
		}
		const invocation = inv.raw.trim();
		this.hub.noteTelegramInput(invocation);
		this.hub.sendToPi(invocation, { expandPromptTemplates: true });
		await this.say(chatId, `❓ 알려진 명령이 아니어서 pi에 그대로 보냈어요. 프롬프트 템플릿/스킬이면 동작합니다. 목록: ${inlineCode("/commands")}`);
	}

	// ------------------------------------------------------------------ lists

	private listRender(spec: ListSpec): ListRender {
		switch (spec.list) {
			case "model": {
				const models = spec.args.trim() ? this.hub.searchModels(spec.args, 80) : this.hub.listModels();
				const local = models.filter((model) => model.local).length;
				return {
					title: `<b>model</b> · ${models.length}${spec.args ? ` "${escapeHtml(spec.args.trim())}"${models.length >= 80 ? ` ✂️ 일부만` : ""}` : " available"}${local ? ` · ${local} local 🏠` : ""}`,
					note: `🏠 = 내 머신 · 🔑 = pi에 이 provider의 인증이 없어요${this.hub.modelProviders().reduce((sum, entry) => sum + entry.count, 0) > models.length + 10 ? ` · 🔎 pi가 아는 모델은 ${this.hub.modelProviders().reduce((sum, entry) => sum + entry.count, 0)}개 — ${inlineCode("/model <검색어>")}나 ${inlineCode("provider/id")}로 직접 지정` : ""}`,
					perPage: 12,
					columns: 1,
					items: models.map((model) => ({
						label: clip(`${model.current ? "● " : "  "}${model.local ? "🏠 " : ""}${model.needsAuth ? "🔑 " : ""}${clip(model.name, 26)} · ${model.provider}`, 62),
						kind: "model:pick" as CallbackActionKind,
						value: model.key,
					})),
				};
			}
			case "model:providers": {
				const providers = this.hub.modelProviders();
				return {
					title: `<b>model</b> 🗂 · ${providers.reduce((sum, entry) => sum + entry.count, 0)}개 · provider를 고르세요`,
					note: `${inlineCode("/model <검색어>")}나 ${inlineCode("/model <provider/id>")}를 직접 입력해도 돼요`,
					perPage: 12,
					columns: 1,
					items: providers.map((entry) => ({
						label: clip(`${entry.local ? "🏠 " : ""}${entry.needsAuth ? "🔑 " : ""}${clip(entry.provider, 28)} · ${entry.count}개`, 62),
						kind: "model:provider" as CallbackActionKind,
						value: entry.provider,
					})),
				};
			}
			case "resume": {
				const sessions = this.hub.listSessionFiles(60);
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? sessions.filter((entry) => entry.label.toLowerCase().includes(query) || (entry.projectLabel ?? "").toLowerCase().includes(query)) : sessions;
				return {
					title: `<b>resume</b> · ${filtered.length} sessions (최신순 · 지금 프로젝트 먼저)`,
					perPage: 8,
					columns: 1,
					items: filtered.map((entry) => ({
						label: clip(`${entry.current ? "● " : "  "}${clip(entry.label, 40)}${entry.projectLabel ? ` ·${entry.projectLabel}` : ""}`, 62),
						kind: "resume:pick" as CallbackActionKind,
						value: entry.path,
					})),
				};
			}
			case "fork": {
				const prompts = this.hub.listPromptEntries(40);
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? prompts.filter((entry) => entry.text.toLowerCase().includes(query)) : prompts;
				return {
					title: `<b>fork</b> · 지점을 선택하세요`,
					perPage: 8,
					columns: 1,
					note: "선택하면 그 프롬프트 시점부터 새 세션이 시작돼요.",
					items: filtered.map((entry) => ({ label: `↪ ${clip(entry.text, 56)}`, kind: "fork:pick" as CallbackActionKind, value: entry.entryId })),
				};
			}
			case "tree": {
				const entries = this.hub.listTreeEntries(60);
				return {
					title: `<b>tree</b> · 이동할 지점 선택`,
					perPage: 8,
					columns: 1,
					note: "요약 없이 해당 지점으로 이동합니다.",
					items: entries.map((entry) => ({ label: `${entry.current ? "● " : "  "}${clip(entry.label, 56)}`, kind: "tree:pick" as CallbackActionKind, value: entry.entryId })),
				};
			}
			case "commands": {
				const all = this.hub.listCommands();
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? all.filter((command) => `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query)) : all;
				return {
					title: `<b>pi commands</b> · ${filtered.length} (extension · template · skill)`,
					perPage: 8,
					columns: 1,
					items: filtered.map((command) => ({
						label: clip(`/${clip(command.name, 34)}${command.description ? ` — ${clip(command.description, 24)}` : ""}`, 62),
						kind: "commands:pick" as CallbackActionKind,
						value: command.name,
					})),
				};
			}
			case "skills": {
				const skills = this.hub.listCommands().filter((command) => command.source === "skill");
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? skills.filter((skill) => skill.name.toLowerCase().includes(query)) : skills;
				return {
					title: `<b>skills</b> · ${filtered.length}`,
					perPage: 8,
					columns: 1,
					items: filtered.map((skill) => ({ label: clip(skill.name, 40), kind: "commands:pick" as CallbackActionKind, value: skill.name })),
				};
			}
			case "tools": {
				const tools = this.hub.listTools();
				return {
					title: `<b>tools</b> · ${tools.filter((tool) => tool.active).length}/${tools.length} active`,
					note: "누르면 바로 적용돼요.",
					perPage: 16,
					columns: 2,
					items: tools.map((tool) => ({ label: `${tool.active ? "✅" : "⬜"} ${clip(tool.name, 20)}`, kind: "tools:toggle" as CallbackActionKind, value: tool.name })),
				};
			}
		}
	}

	private async renderList(chatId: number, spec: ListSpec, editMessageId?: number): Promise<void> {
		const render = this.listRender(spec);
		if (!render.items.length) {
			await this.say(chatId, `⚠️ 항목이 없어요${spec.args ? `: ${inlineCode(spec.args)}` : ""}`);
			return;
		}
		const pages = Math.max(1, Math.ceil(render.items.length / render.perPage));
		const page = Math.min(spec.page, pages - 1);
		const slice = render.items.slice(page * render.perPage, (page + 1) * render.perPage);
		const rows: TgInlineKeyboardButton[][] = [];
		for (let index = 0; index < slice.length; index += render.columns) {
			rows.push(
				slice.slice(index, index + render.columns).map((item) => ({
					text: item.label,
					callback_data: this.hub.createToken({ kind: item.kind, value: item.value }, chatId),
				})),
			);
		}
		if (pages > 1) {
			const nav: TgInlineKeyboardButton[] = [];
			if (page > 0) nav.push({ text: "◀️", callback_data: this.hub.createToken({ kind: "list:page", blob: { ...spec, page: page - 1 } }, chatId) });
			nav.push({ text: `${page + 1}/${pages}`, callback_data: this.hub.createToken({ kind: "noop" }, chatId) });
			if (page < pages - 1) nav.push({ text: "▶️", callback_data: this.hub.createToken({ kind: "list:page", blob: { ...spec, page: page + 1 } }, chatId) });
			rows.push(nav);
		}
		const text = `${render.title}\n${render.note ? `<i>${render.note}</i>\n` : ""}`;
		if (editMessageId) {
			const ok = await this.hub.editKeyboard(chatId, editMessageId, text, rows);
			if (!ok) await this.say(chatId, text, { keyboard: rows });
			return;
		}
		await this.say(chatId, text, { keyboard: rows });
	}

	// -------------------------------------------------------------- callbacks

	async handleCallback(chatId: number, messageId: number | undefined, entry: CallbackEntry): Promise<CallbackResult> {
		const action = entry.action;
		switch (action.kind) {
			case "model:pick": {
				// the key came from a search over the whole registry, so it may not be in the curated list
				await this.applyModelRef(chatId, action.value ?? "");
				return { toast: action.value ?? "" };
			}
			case "model:provider":
				await this.renderList(chatId, { list: "model", args: action.value ?? "", page: 0 });
				return { toast: action.value ?? "" };
			case "thinking:pick": {
				const result = this.hub.setThinkingLevel(action.value ?? "off");
				return { toast: result.ok ? `thinking: ${action.value}` : "변경 실패", showAlert: !result.ok };
			}
			case "resume:pick": {
				if (!action.value) return { toast: "세션을 찾을 수 없어요", showAlert: true };
				await this.say(chatId, "♻️ 세션 불러오는 중…");
				const notice = this.hub.notifyAfterRestart(`♻️ <b>세션 전환</b> 완료 · ${inlineCode(this.hub.sessionInfo().id)}`);
				try {
					await this.hub.withCommandContext(async (ctx) => {
						await ctx.switchSession(action.value!);
					});
					this.hub.clearPendingNotice(notice);
					await this.say(chatId, "✅ 세션 전환 요청이 처리됐어요.");
				} catch (error) {
					this.hub.clearPendingNotice(notice);
					await this.quietSay(chatId, `⚠️ resume 실패: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "resumed" };
			}
			case "fork:pick": {
				if (!action.value) return { toast: "항목을 찾을 수 없어요", showAlert: true };
				const notice = this.hub.notifyAfterRestart(`🌱 <b>fork</b> 완료 — 그 지점부터 새 세션이 이어져요.`);
				try {
					await this.hub.withCommandContext(async (ctx) => {
						await ctx.fork(action.value!, { position: "at" });
					});
					this.hub.clearPendingNotice(notice);
					await this.say(chatId, "🌱 fork 완료 — 새 세션에서 이어가요.");
				} catch (error) {
					this.hub.clearPendingNotice(notice);
					await this.quietSay(chatId, `⚠️ fork 실패: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "forked" };
			}
			case "tree:pick": {
				if (!action.value) return { toast: "항목을 찾을 수 없어요", showAlert: true };
				try {
					tgDebug("tree:pick", action.value);
					// Moving in the tree can make pi summarize branches, and pi refuses prompts while it does.
					this.hub.setContextBusy(true, "tree navigation");
					try {
						await this.hub.withCommandContext(async (ctx) => {
							tgDebug("tree: calling navigateTree");
							const result = await ctx.navigateTree(action.value!, { summarize: false });
							tgDebug("tree: navigateTree returned", result);
						});
					} finally {
						this.hub.setContextBusy(false, "tree navigation");
					}
					tgDebug("tree: context action done, confirming in chat");
					await this.say(chatId, "🌳 이동 완료.");
					tgDebug("tree: confirmation sent");
				} catch (error) {
					tgDebug("tree:pick failed", errorMessage(error));
					await this.say(chatId, `⚠️ tree 이동 실패: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "moved" };
			}
			case "tools:toggle": {
				const tools = this.hub.listTools();
				const active = new Set(tools.filter((tool) => tool.active).map((tool) => tool.name));
				const name = action.value ?? "";
				if (active.has(name)) active.delete(name);
				else active.add(name);
				this.hub.setActiveTools([...active]);
				return { toast: `${name}: ${active.has(name) ? "on" : "off"}` };
			}
			case "tools:reset": {
				this.hub.setActiveTools(this.hub.listTools().map((tool) => tool.name).filter((name) => DEFAULT_TOOLS.includes(name)));
				return { toast: "default tools" };
			}
			case "commands:pick": {
				if (!action.value) return { toast: "명령어를 찾을 수 없어요", showAlert: true };
				this.hub.noteTelegramInput(`/${action.value}`);
				this.hub.sendToPi(`/${action.value}`, { expandPromptTemplates: true });
				return { toast: `/${action.value}` };
			}
			case "list:page": {
				const spec = action.blob as ListSpec;
				if (!spec?.list) return { toast: "목록이 만료됐어요", showAlert: true };
				await this.renderList(chatId, spec, messageId);
				return { toast: "" };
			}
			case "menu:open": {
				const value = action.value ?? "";
				const [command, ...rest] = value.split(/\s+/);
				await this.handle({ chatId, userId: 0, command: command.toLowerCase(), args: rest.join(" "), raw: value });
				return { toast: command };
			}
			case "chat:unpair": {
				const target = Number(action.value ?? "");
				if (!Number.isFinite(target)) return { toast: "잘못된 채팅 id", showAlert: true };
				const removed = this.hub.unpairChat(target);
				return { toast: removed ? `revoked ${target}` : "이미 없음", showAlert: !removed };
			}
			case "noop":
				return { toast: "" };
			default:
				return { toast: "" };
		}
	}

	// ----------------------------------------------------------------- layout

	/** Reply, tolerating a bridge that already went away with a replaced pi session. */
	private async quietSay(chatId: number, html: string): Promise<void> {
		try {
			await this.say(chatId, html);
		} catch {
			/* the pi session (and this bridge instance) was replaced underneath us */
		}
	}

	/** Command replies are built as Telegram HTML, so they skip markdown conversion. */
	private async say(chatId: number, html: string, options?: SendOptions): Promise<void> {
		await this.hub.send(chatId, html, { markdown: false, ...options });
	}

	private menuButton(chatId: number, text: string, commandAndArgs: string): TgInlineKeyboardButton {
		return { text, callback_data: this.hub.createToken({ kind: "menu:open", value: commandAndArgs }, chatId) };
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Error text for a chat window. pi errors quote provider payloads, and providers quote the
 * credential the call carried, so nothing raw from an error ever goes to a phone.
 */
export function safeError(error: unknown): string {
	return redactSecrets(errorMessage(error));
}
