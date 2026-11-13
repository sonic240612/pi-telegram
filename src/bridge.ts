/**
 * The bridge: owns the Telegram connection, pairs chats, routes inbound updates to pi,
 * and implements the Hub interface that the mirror and command layers build on.
 */
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, NOTICE_TTL_MS, resolveToken, saveConfig, writeConfigNow, type TelegramChatRecord, type TelegramConfig } from "./config.ts";
import { CommandLayer, THINKING_LEVELS, TELEGRAM_MENU, errorMessage } from "./commands.ts";
import { DraftManager } from "./draft.ts";
import { GoalView, type FocusState, type GoalSnapshot } from "./goal.ts";
import { QuestionnaireBridge, type EventBusLike } from "./questions.ts";
import { escapeHtml, formatBytes, formatCount, redactSecrets, registerSecret, scrubKnownSecrets, splitLongLine, tgDebug, toHtmlChunks, truncate } from "./format.ts";
import type { CallbackAction, CallbackEntry, Hub, ModelLike, SendOptions, ShellResult, SessionInfoLike } from "./hub.ts";
import { CALLBACK_PREFIX, stripCallbackPrefix } from "./hub.ts";
import { OutboundMirror } from "./mirror.ts";
import { listPromptEntries, listSessions } from "./session-index.ts";
import type { SessionSummary } from "./session-index.ts";
import { TelegramBot, TelegramError, sleep, type TgCallbackQuery, type TgInlineKeyboardButton, type TgMessage, type TgUpdate } from "./telegram.ts";

const COMMAND_RE = /^\/([A-Za-z0-9_-]+)(?:@[A-Za-z0-9_]+)?([\s\S]*)$/;
const CODE_RE = /(?<!\d)(\d{4,6})(?!\d)/;
const PAIRING_TTL_MS = 15 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 400;
/**
 * A pairing code is the only thing between a stranger who found the bot and a pi session that can
 * run bash. Six CSPRNG digits, at most a few guesses before the code rotates and the chat is put in
 * a cooldown, and the operator hears about it.
 */
const PAIR_CODE_RANGE: [number, number] = [100_000, 1_000_000];
const PAIR_MAX_ATTEMPTS = 5;
const PAIR_COOLDOWN_MS = 5 * 60 * 1000;
/** Flood control per chat (tokens, refilled per minute) — a flood would cost the bot its quota. */
const PAIRED_BUDGET = { capacity: 60, refillPerMin: 60 };
const UNPAIRED_BUDGET = { capacity: 10, refillPerMin: 4 };
/** One Telegram message can be 4096 chars; beyond this it becomes a file, not a prompt. */
const MAX_INBOUND_TEXT = 12_000;
/** A declared attachment bigger than this is not downloaded. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ECHO_TTL_MS = 120_000;
/** How long to wait for pi to start a run after a Telegram prompt before telling the chat. */
const PROMPT_WATCHDOG_MS = 8000;
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image"; data: string; mimeType: string };

interface PendingChat {
	chatId: number;
	code: string;
	label: string;
	createdAt: number;
	userId?: number;
	/** Wrong pairing codes from this chat, and the cooldown they bought it. */
	attempts?: number;
	cooldownUntil?: number;
}

export class TelegramBridge implements Hub {
	/** Session replacement (new / resume / fork / reload) re-creates the extension, so several
	 *  bridges can exist in one process. Every debug line is tagged with the instance. */
	static instances = 0;
	readonly instanceId: number;

	readonly cfg: TelegramConfig;
	readonly pi: ExtensionAPI;

	bot?: TelegramBot;

	private readonly drafts: DraftManager;
	private readonly commands: CommandLayer;
	private readonly mirror: OutboundMirror;
	/** Questionnaires other extensions ask (rpiv-ask-user-question), mirrored into the chats. */
	private readonly questions: QuestionnaireBridge;
	/** What pi-goal-x is chasing, read off the session record. */
	private readonly goalView = new GoalView();
	/** A dialog only pi's terminal can answer — worth saying out loud instead of going quiet. */
	private waitingOnTerminal: { kind: string; title?: string; timer?: ReturnType<typeof setTimeout> } | undefined;

	private pollAbort?: AbortController;
	private pollLoop?: Promise<void>;
	private startedAt = Date.now();
	private eventCtx?: ExtensionContext;

	private tokens = new Map<string, CallbackEntry>();
	private questionSeq = 0;
	/** Per-chat inbound allowance, so neither a stranger nor a script can flood the bridge. */
	private inboundBudget = new Map<number, { tokens: number; at: number; warnedAt?: number }>();
	private echoes = new Map<string, number>();
	private pending = new Map<number, PendingChat>();
	private chatTitles = new Map<number, string>();

	private disabled = false;
	/** In-flight teardown, so a session_start that races a shutdown reconnects instead of doing nothing. */
	private stopping?: Promise<void>;
	/** True once pi replaced this session; the bridge instance is a zombie and must not write notices. */
	private replacedSession = false;
	/** Last internal failure, shown by /status and reported to the chats once per message. */
	lastError?: string;

	/**
	 * A prompt pi refuses to run (no model, no provider key, rejected input) produces no transcript
	 * event at all — Telegram would just sit there. Watch for that case and say so.
	 */
	private promptWatch?: { chatId: number; startedAt: number; timer: ReturnType<typeof setTimeout> };
	/** Latency bookkeeping: when the bot connected, when a prompt was handed to pi, how long pi took to start. */
	private connectedAt = 0;
	private lastPromptAt?: number;
	private turnDelays: number[] = [];
	/**
	 * pi throws "Cannot submit a prompt while compaction is in progress" for any prompt sent while it is
	 * compacting or summarizing a branch, and that error is swallowed by pi's runtime, so the message
	 * would simply vanish. Hold those prompts here instead (pi's own terminal does the same thing).
	 */
	private contextBusy = false;
	private compactingAt = 0;
	private heldPrompts: { chatId: number; text: string; content: string | (TextPart | ImagePart)[] }[] = [];
	private menuServed: string[] = [];
	private menuShadowed = false;
	private lastErrorShownAt = new Map<string, number>();

	private actionSeq = 0;
	private pendingActions = new Map<string, (ctx: ExtensionCommandContext) => Promise<void>>();
	private actionSettlers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
	/**
	 * Update handlers run per chat, not inline in the poll loop: one chat waiting on a slow pi
	 * action (a keyboard tap that runs /compact, or a pi dialog nobody answers) must not stall
	 * the whole bridge — pi can also dispose this session mid-action and re-create the extension.
	 */
	private chatQueues = new Map<string, Promise<void>>();
	private inFlight = new Set<Promise<void>>();

	constructor(pi: ExtensionAPI) {
		this.instanceId = ++TelegramBridge.instances;
		this.pi = pi;
		this.cfg = loadConfig();
		this.drafts = new DraftManager(() => this.bot);
		this.commands = new CommandLayer(this);
		this.mirror = new OutboundMirror(this, this.drafts);
		this.questions = new QuestionnaireBridge(this);
	}

	/** Debug lines are tagged per bridge instance: replacement leaves more than one alive. */
	private dbg(...parts: unknown[]): void {
		tgDebug(`bridge#${this.instanceId}`, ...parts);
	}

	// ------------------------------------------------------------------ wiring

	install(): void {
		this.mirror.register(this.pi);
		// pi's extension event bus is how another extension's questionnaire reaches us without touching it.
		const bus = (this.pi as unknown as { events?: EventBusLike }).events;
		if (bus && typeof bus.on === "function" && typeof bus.emit === "function") this.questions.register(bus);
		else this.dbg("no extension event bus — ask-user-question bridging is off");
		this.registerPiCommands();
		this.registerTools();
		this.captureContext();
		this.pi.on("session_start", (_event, ctx) => {
			this.dbg("session_start");
			this.eventCtx = ctx;
			this.restoreGoal(ctx);
			this.refreshStatus();
			// a shutdown for the previous session may still be unwinding; reconnect once it has settled
			if (this.stopping) {
				void this.stopping.then(() => {
					if (!this.bot && !this.disabled) void this.autoStart();
				});
				return;
			}
			if (!this.bot) void this.autoStart();
		});
		this.pi.on("session_shutdown", (event) => {
			// new / resume / fork / reload tear this session down and re-run the extension, so a new
			// bridge instance takes over. Stop quietly (no "stopped" notice) and let it reconnect.
			const replaced = event.reason === "new" || event.reason === "resume" || event.reason === "fork" || event.reason === "reload";
			this.dbg("session_shutdown", event.reason, "replaced:", replaced);
			if (replaced) this.replacedSession = true;
			return this.stop("pi session closed", replaced).then(() => undefined);
		});
		// Safety net so an internal marker never reaches the model if /tgexec is unavailable.
		this.pi.on("input", (event) => {
			if (event.source === "extension" && /^\/tgexec\s/.test(event.text)) return { action: "handled" as const };
			return undefined;
		});
	}

	private captureContext(): void {
		const remember = <T,>(_event: T, ctx: ExtensionContext) => {
			this.eventCtx = ctx;
		};
		this.pi.on("agent_start", () => this.clearPromptWatch("run started"));
		// Compaction can outlast the watchdog window; a prompt waiting behind it is not a stall.
		this.pi.on("session_before_compact", (event) => {
			this.contextBusy = true;
			this.compactingAt = Date.now();
			this.clearPromptWatch("compacting");
			this.dbg("compaction started", event.reason);
			// Fire and forget: this handler must not return a compaction result, and a slow chat
			// must never hold up pi's own compaction.
			void this.announceCompaction(event.reason, event.willRetry);
		});
		this.pi.on("session_compact", (event) => {
			void this.announceCompactionDone(event.compactionEntry, event.reason);
			this.releaseContextBusy("compacted");
		});
		this.pi.on("session_compact_failed", (event) => {
			void this.announceCompactionFailed(event);
			this.releaseContextBusy(event.aborted ? "compaction aborted" : `compaction failed: ${event.errorMessage ?? "?"}`);
		});
		this.pi.on("turn_start", remember);
		this.pi.on("model_select", remember);
		this.pi.on("session_info_changed", remember);
		this.pi.on("session_tree", remember);
		this.pi.on("agent_end", remember);
		// Extensions that block on pi's terminal dialogs leave a phone user staring at silence; say so.
		this.pi.on("ui_prompt_start", (event) => this.noteTerminalDialog(event));
		this.pi.on("ui_prompt_end", () => this.clearTerminalDialog());
	}

	/**
	 * pi-goal-x keeps its goal record in its own files, but the task tools hand that record back in
	 * their tool-result `details` and its focus entry rides the session — both are ours to read, so a
	 * fresh bridge after /resume or /fork still knows what the session is chasing.
	 */
	private restoreGoal(ctx: ExtensionContext): void {
		try {
			const goal = this.goalView.restore(ctx.sessionManager.getBranch());
			this.dbg("goal restore", goal ? `${goal.id} ${goal.status}` : "none");
		} catch (error) {
			this.dbg("goal restore failed", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * An extension dialog rendered in pi's terminal (select/confirm/input/editor/custom) has no
	 * Telegram equivalent unless the extension publishes it — so the run just goes quiet. Say what is
	 * waiting instead. Delayed on purpose: a questionnaire that arrives on the bus a moment later
	 * renders proper buttons, and two notices for one wait would be noise.
	 */
	private noteTerminalDialog(event: { kind: string; title?: string }): void {
		this.clearTerminalDialog();
		if (this.questions.openCount() > 0) return;
		const waiting = { kind: event.kind, ...(event.title ? { title: event.title } : {}) };
		this.waitingOnTerminal = waiting;
		const timer = setTimeout(() => {
			if (!this.waitingOnTerminal || this.waitingOnTerminal !== waiting) return;
			if (this.questions.openCount() > 0 || this.cfg.verbosity < 1) return;
			void this.broadcast(
				`⏸️ <i>pi가 터미널에서 답을 기다려요 (${escapeHtml(waiting.kind)}${waiting.title ? ` · ${escapeHtml(truncate(waiting.title, 80))}` : ""}) — 이 대화상자는 pi 앞에서 답해야 해요.</i>`,
				{ markdown: false },
			).catch(() => undefined);
		}, 1500);
		timer.unref?.();
		this.waitingOnTerminal = { ...waiting, timer };
	}

	private clearTerminalDialog(): void {
		if (this.waitingOnTerminal?.timer) clearTimeout(this.waitingOnTerminal.timer);
		this.waitingOnTerminal = undefined;
	}

	private registerPiCommands(): void {
		this.pi.registerCommand("tgexec", {
			description: "(internal) run a Telegram-queued pi action with a fresh command context",
			handler: async (args, ctx) => {
				const id = args.trim();
				this.eventCtx = ctx;
				const run = this.pendingActions.get(id);
				this.pendingActions.delete(id);
				this.dbg("/tgexec handler", id, "known:", Boolean(run), "idle:", ctx.isIdle());
				if (!run) return;
				const settler = this.actionSettlers.get(id);
				this.actionSettlers.delete(id);
				try {
					await run(ctx);
					this.dbg("/tgexec action finished", id);
					settler?.resolve();
				} catch (error) {
					this.dbg("/tgexec action threw", id, error instanceof Error ? error.message : String(error));
					settler?.reject(error instanceof Error ? error : new Error(String(error)));
				}
			},
		});

		this.pi.registerCommand("telegram", {
			description: "Telegram bridge: status, start/stop, token, pairing",
			getArgumentCompletions: (prefix) =>
				["status", "start", "stop", "restart", "token", "pair", "add", "chats", "verbose"]
					.map((value) => ({ value, label: `telegram ${value}` }))
					.filter((item) => item.value.startsWith(prefix)),
			handler: async (args, ctx) => {
				this.eventCtx = ctx;
				const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				switch (sub) {
					case "status":
						ctx.ui.notify(this.statusLine(), "info");
						this.refreshStatus();
						return;
					case "start":
					case "restart":
						if (rest[0]) this.setToken(rest[0]);
						await this.start();
						return;
					case "stop":
						await this.stop("stopped from pi");
						return;
					case "token":
						if (!rest[0]) {
							ctx.ui.notify("usage: /telegram token <bot-token>", "warning");
							return;
						}
						this.setToken(rest[0]);
						ctx.ui.notify("token saved to ~/.pi/agent/telegram.json", "info");
						await this.start();
						return;
					case "pair":
						this.listPending(ctx);
						return;
					case "add": {
						const chatId = Number(rest[0]);
						if (!Number.isFinite(chatId)) {
							ctx.ui.notify("usage: /telegram add <chatId>", "warning");
							return;
						}
						this.addChat(chatId, this.chatTitles.get(chatId) ?? `chat ${chatId}`);
						ctx.ui.notify(`paired ${chatId}`, "info");
						return;
					}
					case "chats":
						ctx.ui.notify(this.chatsSummary() ?? "no paired chats", "info");
						return;
					case "verbose": {
						const level = Number(rest[0]);
						if (level === 0 || level === 1 || level === 2) {
							this.cfg.verbosity = level;
							this.save();
							ctx.ui.notify(`telegram detail level ${level}`, "info");
						} else ctx.ui.notify("usage: /telegram verbose <0|1|2>", "warning");
						return;
					}
					default:
						ctx.ui.notify("usage: /telegram status|start|stop|restart|token|pair|add|chats|verbose", "info");
				}
			},
		});

		this.pi.registerCommand("telegram-setup", {
			description: "Save a Telegram bot token (from @BotFather) and connect",
			handler: async (args, ctx) => {
				this.eventCtx = ctx;
				const token = args.trim().split(/\s+/)[0];
				if (!token) {
					ctx.ui.notify("usage: /telegram-setup <bot-token>", "warning");
					return;
				}
				this.setToken(token);
				await this.start();
			},
		});

		this.pi.registerCommand("telegram-pair", {
			description: "Approve a pending Telegram chat (/telegram-pair [code])",
			handler: async (args, ctx) => {
				this.eventCtx = ctx;
				const code = args.trim().replace(/\D/g, "");
				const pending = [...this.pending.values()];
				if (!code) {
					this.listPending(ctx);
					return;
				}
				const match = pending.find((entry) => entry.code === code);
				if (!match) {
					ctx.ui.notify(`no pending chat with code ${code}`, "warning");
					this.listPending(ctx);
					return;
				}
				this.approvePending(match);
				ctx.ui.notify(`paired ${match.label} (${match.chatId})`, "info");
				await this.sendHtml(match.chatId, "✅ pairing approved — 텍스트는 이제 pi 프롬프트로 바로 전달됩니다.\n/help 로 명령어를 볼 수 있어요.").catch(() => undefined);
			},
		});

		this.pi.registerCommand("telegram-chats", {
			description: "List paired Telegram chats",
			handler: async (_args, ctx) => {
				this.eventCtx = ctx;
				ctx.ui.notify(this.chatsSummary() ?? "no paired chats", "info");
			},
		});

		this.pi.registerCommand("telegram-verbose", {
			description: "Telegram output detail: 0 answers · 1 +tools · 2 full mirror",
			handler: async (args, ctx) => {
				this.eventCtx = ctx;
				const level = args.trim() === "" ? this.cfg.verbosity : Number(args.trim());
				if (level === 0 || level === 1 || level === 2) {
					this.cfg.verbosity = level;
					this.save();
					ctx.ui.notify(`telegram detail level ${level}`, "info");
				} else ctx.ui.notify("usage: /telegram-verbose <0|1|2>", "warning");
			},
		});
	}

	private listPending(ctx: ExtensionContext): void {
		const pending = [...this.pending.values()];
		if (!pending.length) {
			ctx.ui.notify('no pending Telegram chats. Have someone send the bot any message, then approve here with "/telegram-pair <code>".', "info");
			return;
		}
		for (const entry of pending) ctx.ui.notify(`pending: ${entry.label} (${entry.chatId}) → code ${entry.code} — approve with /telegram-pair ${entry.code}`, "info");
	}

	private registerTools(): void {
		this.pi.registerTool({
			name: "telegram_send",
			label: "Telegram send",
			description: "Send a message, image, or file to the paired Telegram chats. Use it when the user asks for output on Telegram.",
			promptSnippet: "Push messages, images, and files to the user's Telegram chats",
			promptGuidelines: ["When the user is messaging from Telegram, push long output, images, and generated files with telegram_send."],
			parameters: Type.Object({
				text: Type.Optional(Type.String({ description: "Message text (markdown supported)" })),
				path: Type.Optional(Type.String({ description: "File to attach (absolute or working-directory relative)" })),
				caption: Type.Optional(Type.String({ description: "Caption for the attached file" })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const text = (params.text ?? "").trim();
				const target = (params.path ?? "").trim();
				if (!text && !target) return { content: [{ type: "text", text: "telegram_send: needs text or path" }], details: sendDetails(0) };
				let sent = 0;
				if (text) {
					await this.broadcast(text);
					sent = this.chats().length;
				}
				if (target) {
					const resolved = isAbsolute(target) ? target : join(ctx.cwd, target);
					if (!existsSync(resolved)) return { content: [{ type: "text", text: `telegram_send: file not found: ${resolved}` }], details: sendDetails(sent) };
					const data = Uint8Array.from(readFileSync(resolved));
					// Any file pi can read can leave this machine through this tool. Say so in the terminal.
					this.eventCtx?.ui.notify(`telegram_send attached ${resolved} (${formatBytes(data.byteLength)}) to ${this.chats().length} chat(s)`, "info");
					for (const chatId of this.chats()) {
						try {
							await this.sendFile(chatId, data, basename(resolved), params.caption);
							sent += 1;
						} catch (error) {
							return { content: [{ type: "text", text: `telegram_send failed: ${errorMessage(error)}` }], details: sendDetails(sent, errorMessage(error)), isError: true };
						}
					}
				}
				return { content: [{ type: "text", text: `sent to ${sent} Telegram chat(s)` }], details: sendDetails(sent) };
			},
		});

		this.pi.registerTool({
			name: "telegram_ask",
			label: "Telegram ask",
			description: "Ask the Telegram user a question with tappable buttons and wait for their answer.",
			promptSnippet: "Ask the Telegram user a question with buttons and wait for the choice",
			parameters: Type.Object({
				question: Type.String({ description: "Question shown on Telegram" }),
				options: Type.Array(Type.String(), { description: "Choices rendered as buttons (max 12)" }),
				timeout_seconds: Type.Optional(Type.Number({ description: "Give up after this many seconds (default 600)" })),
			}),
			execute: async (_toolCallId, params, signal) => {
				const chats = this.chats();
				if (!chats.length) return { content: [{ type: "text", text: "telegram_ask: no paired chat" }], details: askDetails(false) };
				const options = params.options.slice(0, 12);
				const timeoutMs = Math.max(10, Math.min(3600, params.timeout_seconds ?? 600)) * 1000;
				const answer = await this.ask(chats[0], params.question, options, timeoutMs, signal);
				if (answer == null) return { content: [{ type: "text", text: "telegram_ask: no answer (timeout or cancelled)" }], details: askDetails(false) };
				return { content: [{ type: "text", text: answer }], details: askDetails(true, answer) };
			},
		});
	}

	private ask(chatId: number, question: string, options: string[], timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
		return new Promise((resolve) => {
			const questionId = `q${++this.questionSeq}`;
			let settled = false;
			const finish = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				for (const [token, entry] of this.tokens) {
					if (entry.action.kind === "ask:answer" && entry.action.blob && (entry.action.blob as { questionId?: string }).questionId === questionId) this.tokens.delete(token);
				}
				resolve(value);
			};
			const rows: TgInlineKeyboardButton[][] = [];
			for (let index = 0; index < options.length; index += 2) {
				rows.push(
					options.slice(index, index + 2).map((option) => ({
						text: option.slice(0, 48),
						callback_data: this.createToken({ kind: "ask:answer", value: option, blob: { questionId } }, chatId, {
							resolve: (answer) => finish(answer),
						}),
					})),
				);
			}
			const timer = setTimeout(() => finish(undefined), timeoutMs);
			timer.unref?.();
			const onAbort = () => finish(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
			void this.sendHtml(chatId, `❓ ${escapeHtml(question)}`, { keyboard: rows }).catch(() => finish(undefined));
		});
	}

	// ------------------------------------------------------------ connection

	setToken(token: string): void {
		this.cfg.token = token.trim();
		writeConfigNow(this.cfg);
	}

	async start(): Promise<{ ok: boolean; error?: string }> {
		const token = resolveToken(this.cfg);
		if (!token) {
			this.eventCtx?.ui.notify("telegram: no token. run /telegram-setup <bot-token> or set TELEGRAM_BOT_TOKEN.", "warning");
			return { ok: false, error: "no token configured" };
		}
		// Everything this bridge writes to chats, files and stderr is scrubbed of the token from here on:
		// it travels in every request path, so it must never appear in a message we did not author.
		registerSecret(token);
		await this.stop(undefined, true);
		// A replacement session builds this instance while the previous one is still writing config;
		// pick up whatever it persisted so no update is replayed and no notice is lost.
		this.adoptPersistedState();
		try {
			const bot = new TelegramBot(token);
			const me = await bot.getMe();
			this.connectedAt = Date.now();
			await this.registerMenu(bot);
			this.bot = bot;
			this.startedAt = Date.now();
			this.pollAbort = new AbortController();
			this.pollLoop = this.runPollLoop(this.pollAbort.signal);
			this.refreshStatus();
			if (this.cfg.announce) {
				await this.broadcast(`🟢 <b>${escapeHtml(displayName(me))}</b> · pi 연결됨\n${this.cfg.chats.length} chat(s) · detail ${this.cfg.verbosity} · drafts ${this.cfg.streaming ? "on" : "off"}`, { markdown: false });
			}
			await this.flushPendingNotice();
			this.eventCtx?.ui.notify(`telegram bridge connected as ${displayName(me)}`, "info");
			return { ok: true };
		} catch (error) {
			this.eventCtx?.ui.notify(`telegram start failed: ${errorMessage(error)}${error instanceof TelegramError && /unauthorized/i.test(error.message) ? " — check the token (/telegram token <new>)" : ""}`, "error");
			return { ok: false, error: errorMessage(error) };
		}
	}

	/** Take over update position and queued notices from a predecessor instance. */
	private adoptPersistedState(): void {
		const onDisk = loadConfig();
		if (typeof onDisk.offset === "number" && onDisk.offset > (this.cfg.offset ?? 0)) this.cfg.offset = onDisk.offset;
		if (onDisk.pendingNotice) this.cfg.pendingNotice = onDisk.pendingNotice;
	}

	/** Deliver a notice written by the instance that started a session replacement. */
	private async flushPendingNotice(): Promise<void> {
		const notice = this.cfg.pendingNotice;
		if (!notice) return;
		this.cfg.pendingNotice = undefined;
		writeConfigNow(this.cfg);
		if (Date.now() - notice.at > NOTICE_TTL_MS) return;
		await this.broadcast(notice.text, { markdown: false, silent: true }).catch(() => undefined);
	}

	async stop(reason?: string, silent = false): Promise<void> {
		const task = this.stopInner(reason, silent);
		this.stopping = task;
		try {
			await task;
		} finally {
			if (this.stopping === task) this.stopping = undefined;
		}
	}

	private async stopInner(reason?: string, silent = false): Promise<void> {
		this.dbg("stop", reason, "silent:", silent, "replaced:", this.replacedSession);
		this.clearPromptWatch("bridge stopped");
		this.clearTerminalDialog();
		// A questionnaire belonged to this session; leave dead buttons in the chats and they invite taps.
		this.questions.closeAll("pi 세션이 끝나면서 질문도 닫혔어요.");
		this.pollAbort?.abort();
		const loop = this.pollLoop;
		this.pollLoop = undefined;
		this.pollAbort = undefined;
		if (loop) await loop.catch(() => undefined);
		const bot = this.bot;
		if (bot && !silent && this.cfg.announce && reason) await this.broadcast(`🔴 bridge stopped · ${escapeHtml(reason)}`, { markdown: false }).catch(() => undefined);
		this.bot = undefined;
		if (this.replacedSession) {
			// Actions waiting on the disposed session can never land; let those handlers unwind and
			// fail quietly instead of holding their chat queue for the full command timeout.
			for (const [id, settler] of this.actionSettlers) {
				this.pendingActions.delete(id);
				settler.resolve();
			}
			this.actionSettlers.clear();
		}
		// let in-flight chat handlers finish so their replies are not lost mid-action
		if (this.inFlight.size) {
			await Promise.race([Promise.allSettled([...this.inFlight]), sleep(3000)]);
			this.inFlight.clear();
		}
		this.mirror.stopTyping();
		this.drafts.releaseAll();
		this.refreshStatus();
	}

	restartBridge(): void {
		void this.start();
	}

	/**
	 * Queue a chat notice for the bridge that will exist after a session replacement.
	 * /new, /resume and /fork dispose this pi session and re-create the extension, so the instance
	 * running the action is gone by the time the action lands — the fresh instance sends this.
	 */
	notifyAfterRestart(text: string): number {
		const at = Date.now();
		this.cfg.pendingNotice = { text, at };
		writeConfigNow(this.cfg);
		return at;
	}

	/** Drop a queued notice (the action failed before any session replacement happened). */
	clearPendingNotice(at?: number): void {
		// Once pi replaced the session this instance is a zombie: the notice belongs to the new one.
		if (this.replacedSession) return;
		const notice = this.cfg.pendingNotice;
		if (!notice || (at != null && notice.at !== at)) return;
		this.cfg.pendingNotice = undefined;
		writeConfigNow(this.cfg);
	}

	/** --telegram-off: never connect automatically, but /telegram start still works. */
	disable(): void {
		this.disabled = true;
		if (this.bot) void this.stop("disabled by --telegram-off");
	}

	private async autoStart(): Promise<void> {
		if (this.disabled || !resolveToken(this.cfg)) return;
		await this.start();
	}

	private async runPollLoop(signal: AbortSignal): Promise<void> {
		let offset = this.cfg.offset ?? 0;
		let failures = 0;
		this.dbg("poll loop open at offset", offset);
		while (!signal.aborted) {
			try {
				const bot = this.bot;
				if (!bot) return;
				const updates = await bot.getUpdates(offset, 25);
				failures = 0;
				if (updates.length) this.dbg("poll batch", updates.length, "offset", offset);
				for (const update of updates) {
					if (signal.aborted) return;
					offset = Math.max(offset, update.update_id + 1);
					this.cfg.offset = offset;
					this.enqueueUpdate(update);
				}
				if (updates.length) saveConfig(this.cfg);
			} catch (error) {
				if (signal.aborted) return;
				failures += 1;
				if (error instanceof TelegramError && error.code === 409) {
					this.eventCtx?.ui.notify("telegram: 409 conflict — another poller or a webhook already uses this token.", "warning");
					await sleep(5000);
					continue;
				}
				if (failures === 3) this.eventCtx?.ui.notify(`telegram connection trouble: ${errorMessage(error)}`, "warning");
				await sleep(Math.min(20_000, 1000 * 2 ** Math.min(failures, 5)));
			}
		}
	}

	// --------------------------------------------------------------- inbound

	/** Serialize handling per chat; keep the poll loop free so one slow action cannot freeze everything. */
	private enqueueUpdate(update: TgUpdate): void {
		const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id ?? update.edited_message?.chat.id ?? update.channel_post?.chat.id ?? 0;
		const key = String(chatId);
		const previous = this.chatQueues.get(key) ?? Promise.resolve();
		const task = previous
			.then(() => this.handleUpdate(update))
			.catch((error: unknown) => this.reportError(`update ${update.update_id}`, error))
			.finally(() => {
				this.inFlight.delete(task);
				if (this.chatQueues.get(key) === task) this.chatQueues.delete(key);
			});
		this.inFlight.add(task);
		this.chatQueues.set(key, task);
	}

	private async handleUpdate(update: TgUpdate): Promise<void> {
		const message = update.message ?? update.edited_message ?? update.channel_post;
		if (message) {
			await this.handleMessage(message, Boolean(update.edited_message));
			return;
		}
		if (update.callback_query) await this.handleCallbackQuery(update.callback_query);
	}

	/** Token bucket per chat: burst allowance refilled over time. True means "you may proceed". */
	private allowInbound(chatId: number, paired: boolean): boolean {
		const budget = paired ? PAIRED_BUDGET : UNPAIRED_BUDGET;
		const now = Date.now();
		const entry = this.inboundBudget.get(chatId) ?? { tokens: budget.capacity, at: now };
		entry.tokens = Math.min(budget.capacity, entry.tokens + ((now - entry.at) / 60_000) * budget.refillPerMin);
		entry.at = now;
		if (entry.tokens < 1) {
			this.inboundBudget.set(chatId, entry);
			return false;
		}
		entry.tokens -= 1;
		this.inboundBudget.set(chatId, entry);
		return true;
	}

	private rememberChat(message: TgMessage): string {
		const chatId = message.chat.id;
		const label = message.chat.title ?? [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ") ?? message.chat.username ?? `chat ${chatId}`;
		this.chatTitles.set(chatId, label);
		return label;
	}

	private async handleMessage(message: TgMessage, edited: boolean): Promise<void> {
		const chatId = message.chat.id;
		const label = this.rememberChat(message);
		const text = (message.text ?? message.caption ?? "").trim();

		if (!this.isPaired(chatId)) {
			// Strangers get a strict budget and no reply once it runs out: an unanswered bot does not
			// burn the quota that the operator's mirrored answers need.
			if (!this.allowInbound(chatId, false)) {
				this.dbg("unpaired flood dropped", chatId);
				return;
			}
			await this.handleUnpairedChat(chatId, label, text, message);
			return;
		}
		if (!this.allowInbound(chatId, true)) {
			const budget = this.inboundBudget.get(chatId);
			if (!budget?.warnedAt || Date.now() - budget.warnedAt > 60_000) {
				if (budget) budget.warnedAt = Date.now();
				await this.sendHtml(chatId, `⏳ <i>너무 빨라요 — 잠시 후 다시 보내 주세요 (1분당 약 ${PAIRED_BUDGET.refillPerMin}개 처리).</i>`);
			}
			return;
		}
		if (text.length > MAX_INBOUND_TEXT) {
			await this.sendHtml(
				chatId,
				`⚠️ <i>지나치게 긴 메시지예요 (${text.length}자, 최대 ${MAX_INBOUND_TEXT}). 파일로 보내 주시면 전체를 읽을 수 있어요 — 예: /bash 로 읽히기.</i>`,
			);
			return;
		}
		if (edited) {
			await this.sendHtml(chatId, "ℹ️ 편집된 메시지는 무시했어요. 처음부터 다시 보내 주세요.");
			return;
		}
		if (!message.from && message.chat.type !== "channel") return;

		const match = COMMAND_RE.exec(text);
		if (match) {
			const command = match[1].toLowerCase();
			const args = (match[2] ?? "").trim();
			this.dbg("command", `/${command}`, args.slice(0, 40));
			try {
				await this.commands.handle({ chatId, userId: message.from?.id ?? chatId, command, args, raw: text });
			} catch (error) {
				await this.sendHtml(chatId, `⚠️ /${escapeHtml(command)} 실패: ${escapeHtml(errorMessage(error))}`);
			}
			return;
		}
		// A chat sitting in ✏️ mode is answering somebody else's questionnaire, not prompting pi.
		if (await this.questions.consumeText(chatId, text)) {
			this.dbg("typed answer captured", chatId);
			return;
		}
		await this.deliverToPi(chatId, message, text);
	}

	private async handleUnpairedChat(chatId: number, label: string, text: string, message: TgMessage): Promise<void> {
		const entry = this.pending.get(chatId);
		const codeMatch = CODE_RE.exec(text);
		if (entry && entry.cooldownUntil && Date.now() < entry.cooldownUntil) {
			const wait = Math.ceil((entry.cooldownUntil - Date.now()) / 1000);
			await this.sendHtml(chatId, `⏳ <i>코드를 ${PAIR_MAX_ATTEMPTS}번 틀려서 일시 정지 — ${wait}초 후 새 코드로 다시 시도하세요. 운영자에게 알렸어요.</i>`);
			return;
		}
		if (entry && codeMatch && entry.code === codeMatch[1]) {
			this.approvePending(entry);
			await this.sendHtml(chatId, "✅ paired! 텍스트는 pi 프롬프트로 바로 전달됩니다.\n/help 로 명령어를 볼 수 있어요.");
			this.eventCtx?.ui.notify(`telegram paired: ${label} (${chatId})`, "info");
			return;
		}
		if (entry && codeMatch) {
			// A wrong code is someone trying to get in. Rotate, cool down, and tell the operator.
			entry.attempts = (entry.attempts ?? 0) + 1;
			if (entry.attempts >= PAIR_MAX_ATTEMPTS) {
				entry.cooldownUntil = Date.now() + PAIR_COOLDOWN_MS;
				entry.code = randomCode();
				entry.attempts = 0;
				this.eventCtx?.ui.notify(
					`telegram: ${label} (${chatId}) guessed pairing codes ${PAIR_MAX_ATTEMPTS} times — code rotated, chat on cooldown for ${PAIR_COOLDOWN_MS / 60_000} minutes`,
					"warning",
				);
				await this.sendHtml(chatId, `⛔ <i>코드를 여러 번 틀렸어요. 코드가 바뀌었고 잠시 후 다시 시도할 수 있어요.</i>`);
				return;
			}
			await this.sendHtml(chatId, `⛔ <i>그 코드가 아니에요 (${entry.attempts}/${PAIR_MAX_ATTEMPTS}). 운영자에게 코드를 다시 물어보세요.</i>`);
			return;
		}
		const fresh: PendingChat = entry ?? { chatId, code: randomCode(), label, createdAt: Date.now(), userId: message.from?.id };
		fresh.label = label;
		this.pending.set(chatId, fresh);
		this.prunePending();
		await this.sendHtml(
			chatId,
			`🔒 <b>pairing 필요</b>\npi 운영자가 pi 터미널에서 확인해야 합니다:\n1. <code>/telegram-pair</code> → 대기 목록과 코드 확인\n2. pi에서 <code>/telegram-pair &lt;code&gt;</code> 실행\n\n또는 운영자가 보내준 ${PAIR_CODE_RANGE[0].toString().length}자리 코드를 여기에 입력하면 허용됩니다.`,
		);
		this.eventCtx?.ui.notify(`telegram pairing request: ${label} (${chatId}) → code ${fresh.code} (approve with /telegram-pair ${fresh.code})`, "info");
	}

	private approvePending(entry: PendingChat): void {
		this.pending.delete(entry.chatId);
		this.addChat(entry.chatId, entry.label);
	}

	private addChat(chatId: number, label: string): void {
		if (this.cfg.chats.some((chat) => chat.chatId === chatId)) return;
		const record: TelegramChatRecord = { chatId, label, addedAt: Date.now() };
		this.cfg.chats.push(record);
		writeConfigNow(this.cfg);
	}

	private prunePending(): void {
		const now = Date.now();
		for (const [chatId, entry] of this.pending) if (now - entry.createdAt > PAIRING_TTL_MS) this.pending.delete(chatId);
	}

	private async deliverToPi(chatId: number, message: TgMessage, text: string): Promise<void> {
		const images = await this.collectAttachments(chatId, message);
		const quoted = message.reply_to_message
			? `[replying to: ${truncate((message.reply_to_message.text ?? message.reply_to_message.caption ?? "(non-text message)").replace(/\s+/g, " "), 400)}]\n`
			: "";
		const body = `${quoted}${text}`.trim();
		if (!body && !images.length) {
			await this.sendHtml(chatId, "ℹ️ 텍스트·이미지·PDF·코드 파일을 보내 주세요. 명령어 목록은 /help");
			return;
		}
		if (body) this.noteTelegramInput(body);
		const content: string | (TextPart | ImagePart)[] = images.length
			? [{ type: "text", text: body || "(see attached)" }, ...images]
			: body;
		if (this.contextBusy) {
			this.heldPrompts.push({ chatId, text: body, content });
			await this.sendHtml(
				chatId,
				`⏳ <i>지금 컨텍스트를 압축/요약 중이에요. 이 메시지는 그다음에 pi에 전달될 거예요 (대기 ${this.heldPrompts.length}개).</i>`,
			);
			this.dbg("prompt held for compaction", chatId, body.slice(0, 40));
			return;
		}
		try {
			this.pi.sendUserMessage(content, this.isIdle() ? undefined : { deliverAs: "steer" });
			this.watchPrompt(chatId);
			// Fire and forget: the typing hint is throttled on its own lane and must never delay the
			// rest of this chat's queue (the mirror keeps it alive while pi runs).
			void this.bot?.sendChatAction(chatId, "typing");
		} catch (error) {
			await this.sendHtml(chatId, `⚠️ pi에 보내지 못했어요: ${escapeHtml(redactSecrets(errorMessage(error)))}`);
		}
	}

	/** Used by our own session-control paths (tree navigation can generate branch summaries). */
	setContextBusy(busy: boolean, reason: string): void {
		if (this.contextBusy === busy) return;
		this.contextBusy = busy;
		this.dbg("context busy", busy, reason);
		if (!busy) void this.releaseHeldPrompts(reason);
	}

	/** pi blocks prompts while it compacts, so the chat is told what it is waiting for. */
	private async announceCompaction(reason: CompactionReason, willRetry: boolean): Promise<void> {
		const usage = this.eventCtx?.getContextUsage();
		const size = usage?.tokens != null ? ` · ${formatCount(usage.tokens)} tokens${usage.percent != null ? ` · ${Math.round(usage.percent)}%` : ""}` : "";
		const held = this.heldPrompts.length ? `\n· 이미 보낸 메시지 ${this.heldPrompts.length}개는 압축이 끝나면 자동으로 전달돼요.` : "";
		await this.broadcast(`🗜 <i>컨텍스트 압축 중…</i>${size}\n· ${compactionReasonLabel(reason)}${willRetry ? " · 압축 후 지금 턴을 다시 시도해요" : ""}${held}`, { markdown: false });
	}

	private async announceCompactionDone(entry: { tokensBefore?: number } | undefined, reason: CompactionReason): Promise<void> {
		const seconds = this.compactingAt ? ` · ${((Date.now() - this.compactingAt) / 1000).toFixed(1)}s` : "";
		this.compactingAt = 0;
		const before = typeof entry?.tokensBefore === "number" ? formatCount(entry.tokensBefore) : undefined;
		const after = this.eventCtx?.getContextUsage()?.tokens;
		const delta = before ? ` · ${before} → ${after != null ? formatCount(after) : "요약"}` : "";
		await this.broadcast(`✅ <i>컨텍스트 압축 완료</i>${delta}${seconds}\n· ${compactionReasonLabel(reason)}`, { markdown: false });
	}

	private async announceCompactionFailed(event: { aborted: boolean; errorMessage?: string; reason: CompactionReason }): Promise<void> {
		this.compactingAt = 0;
		const detail = event.errorMessage ? `: ${escapeHtml(truncate(redactSecrets(event.errorMessage), 300))}` : "";
		await this.broadcast(`⚠️ <i>컨텍스트 압축 ${event.aborted ? "중단" : "실패"}</i>${detail}\n· ${compactionReasonLabel(event.reason)}`, { markdown: false });
	}

	private releaseContextBusy(reason: string): void {
		this.contextBusy = false;
		this.dbg("context free", reason, "held:", this.heldPrompts.length);
		void this.releaseHeldPrompts(reason);
	}

	/** Deliver everything Telegram parked while pi was busy rebuilding its context. */
	private async releaseHeldPrompts(reason: string): Promise<void> {
		if (!this.heldPrompts.length) return;
		const held = this.heldPrompts;
		this.heldPrompts = [];
		for (const entry of held) {
			try {
				this.pi.sendUserMessage(entry.content, this.isIdle() ? undefined : { deliverAs: "followUp" });
				this.watchPrompt(entry.chatId);
				void this.bot?.sendChatAction(entry.chatId, "typing");
			} catch (error) {
				this.reportError("held prompt", error);
				await this.sendHtml(entry.chatId, `⚠️ 압축 뒤에 보내려던 메시지를 전달하지 못했어요: ${escapeHtml(redactSecrets(errorMessage(error)))}`);
			}
		}
		this.dbg("held prompts released", reason, held.length);
		const perChat = new Map<number, number>();
		for (const entry of held) perChat.set(entry.chatId, (perChat.get(entry.chatId) ?? 0) + 1);
		for (const [chat, count] of perChat) await this.sendHtml(chat, `✅ <i>압축 끝 — 기다리던 메시지 ${count}개를 pi에 보냈어요.</i>`);
	}

	private watchPrompt(chatId: number): void {
		this.clearPromptWatch();
		this.lastPromptAt = Date.now();
		const timer = setTimeout(() => void this.promptStall(chatId), PROMPT_WATCHDOG_MS);
		timer.unref?.();
		this.promptWatch = { chatId, startedAt: Date.now(), timer };
		this.dbg("prompt watch armed", chatId);
	}

	private clearPromptWatch(reason?: string): void {
		const watch = this.promptWatch;
		if (!watch) return;
		clearTimeout(watch.timer);
		this.promptWatch = undefined;
		if (reason === "run started" && this.lastPromptAt) {
			// How long pi took to actually start the run — the number users feel as "천천히 답 온다".
			this.turnDelays.push(Date.now() - this.lastPromptAt);
			if (this.turnDelays.length > 6) this.turnDelays.shift();
		}
		if (reason) this.dbg("prompt watch:", reason);
	}

	/** No run ever started for a delivered prompt: say why instead of leaving the chat hanging. */
	private async promptStall(chatId: number): Promise<void> {
		this.promptWatch = undefined;
		this.dbg("prompt watchdog check", chatId, "bot:", Boolean(this.bot), "idle:", this.eventCtx ? this.eventCtx.isIdle() : "no ctx");
		if (!this.bot) return; // bridge already stopped; the replacement instance owns the chat now
		const ctx = this.eventCtx;
		if (ctx && !ctx.isIdle()) return; // a run is in flight, it was just slow to announce
		const model = this.currentModelKey() ?? "없음";
		const why = !ctx
			? "브리지에 pi 세션 정보가 없어요. /tg restart 후 다시 시도하세요."
			: !ctx.model
				? "선택된 모델이 없어요 — pi 터미널에서 /model 또는 /login 으로 provider를 연결하세요."
				: "pi가 실행을 시작하지 않았어요 — provider 인증이나 모델 설정을 확인하세요 (pi 터미널에 오류가 찍혔을 수 있어요).";
		const lastError = this.lastError ? `\n마지막 브리지 오류: ${escapeHtml(redactSecrets(truncate(this.lastError, 200)))}` : "";
		this.dbg("prompt watchdog fired", chatId, "model:", model);
		await this.sendHtml(chatId, `⚠️ <b>프롬프트가 pi에서 실행되지 않았어요</b>\n모델 <code>${escapeHtml(model)}</code> · ${escapeHtml(why)}\n/status 로 상태를 확인하세요.${lastError}`);
	}

	private async collectAttachments(chatId: number, message: TgMessage): Promise<ImagePart[]> {
		if (!this.bot) return [];
		this.dbg("attachments", chatId, "photo:", message.photo?.length ?? 0, "doc:", message.document?.file_name ?? "-", "voice:", message.voice ? 1 : 0);
		const images: ImagePart[] = [];
		const notes: string[] = [];
		const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
		if (photo) {
			try {
				images.push(await this.downloadImage(photo.file_id));
			} catch (error) {
				notes.push(`image download failed: ${errorMessage(error)}`);
			}
		}
		const document = message.document;
		const oversized = Boolean(document?.file_size && document.file_size > MAX_ATTACHMENT_BYTES);
		if (oversized && document?.file_size) {
			notes.push(`파일이 너무 커요 (${formatBytes(document.file_size)}, 최대 ${formatBytes(MAX_ATTACHMENT_BYTES)}) — 더 작은 조각으로 보내 주세요`);
		}
		if (document && !oversized) {
			const mime = document.mime_type ?? "";
			this.dbg("attachment document", document.file_name ?? "?", mime || "(no mime)");
			if (mime.startsWith("image/")) {
				try {
					images.push(await this.downloadImage(document.file_id));
				} catch (error) {
					notes.push(`image download failed: ${errorMessage(error)}`);
				}
			} else if (isTextLike(document.file_name, mime)) {
				try {
					const raw = await this.download(document.file_id);
					this.dbg("document inlined", document.file_name, raw.byteLength, "bytes");
					const name = safeFileName(document.file_name ?? "attachment");
					const body = Buffer.from(raw).toString("utf8");
					this.pi.sendUserMessage([{ type: "text", text: `Attached file from Telegram: ${name}\n\n\`\`\`\n${truncate(body, 24_000)}\n\`\`\`` }]);
				} catch (error) {
					notes.push(`file read failed: ${errorMessage(error)}`);
				}
			} else {
				notes.push(`unsupported attachment: ${safeFileName(document.file_name ?? "")} (${formatBytes(document.file_size ?? 0)}) — save it locally and reference the path`);
			}
		}
		if (message.audio || message.voice) notes.push("voice messages are not transcribed — send text");
		if (message.video || message.animation || message.video_note) notes.push("video is not forwarded to pi");
		if (message.sticker) notes.push(`sticker ${message.sticker.emoji ?? ""}`.trim());
		if (notes.length) await this.sendHtml(chatId, `ℹ️ ${escapeHtml(notes.join(" · "))}`).catch(() => undefined);
		return images;
	}

	private async download(fileId: string): Promise<Uint8Array> {
		const file = await this.bot?.getFile(fileId);
		if (!file?.file_path) throw new TelegramError("getFile", 404, "telegram did not return a file path");
		return this.bot!.downloadFile(file.file_path);
	}

	private async downloadImage(fileId: string): Promise<ImagePart> {
		const file = await this.bot?.getFile(fileId);
		if (!file?.file_path) throw new TelegramError("getFile", 404, "telegram did not return a file path");
		const data = await this.bot!.downloadFile(file.file_path);
		const mimeType = /\.png$/i.test(file.file_path) ? "image/png" : /\.gif$/i.test(file.file_path) ? "image/gif" : /\.webp$/i.test(file.file_path) ? "image/webp" : "image/jpeg";
		return { type: "image", data: Buffer.from(data).toString("base64"), mimeType };
	}

	private async handleCallbackQuery(query: TgCallbackQuery): Promise<void> {
		const data = query.data ?? "";
		const chatId = query.message?.chat.id ?? 0;
		if (!data.startsWith(CALLBACK_PREFIX)) {
			await this.bot?.answerCallbackQuery(query.id);
			return;
		}
		if (!this.isPaired(chatId)) {
			await this.bot?.answerCallbackQuery(query.id, "pairing required", true);
			return;
		}
		const token = data.slice(CALLBACK_PREFIX.length);
		const entry = this.tokens.get(token);
		this.dbg("callback", data, "known:", Boolean(entry), "action:", entry?.action.kind);
		if (!entry) {
			await this.bot?.answerCallbackQuery(query.id, "이 버튼은 만료됐어요 — /help 로 다시 여세요", true);
			if (query.message && chatId) await this.bot?.clearKeyboard(chatId, query.message.message_id);
			return;
		}
		if (entry.chatId !== chatId) {
			// A button is for the chat it was rendered into. Without this, any paired chat (or any member
			// of a paired group) could replay another chat's keyboard — switch models, resume a foreign
			// session, unpair a chat.
			await this.bot?.answerCallbackQuery(query.id, "이 버튼은 다른 채팅에서 열린 거예요", true);
			this.dbg("callback token from the wrong chat", chatId, "->", entry.chatId);
			this.eventCtx?.ui.notify(`telegram: ignored a keyboard tap from chat ${chatId} — that button belongs to ${entry.chatId}`, "warning");
			return;
		}
		if (entry.action.kind === "ask:answer") {
			const value = entry.action.value ?? "";
			entry.answer?.resolve(value);
			await this.bot?.answerCallbackQuery(query.id, value);
			return;
		}
		try {
			if (entry.action.kind.startsWith("askq:")) {
				// A questionnaire another extension asked: whoever taps first answers it, and the
				// keyboards in the other chats close once one answer landed.
				const result = await this.questions.handleCallback(chatId, query.message?.message_id, entry);
				await this.bot?.answerCallbackQuery(query.id, result.toast || undefined, result.showAlert);
				if (result.keep) this.keepToken(token);
				else this.dropToken(token);
				return;
			}
			const result = await this.commands.handleCallback(chatId, query.message?.message_id, entry);
			await this.bot?.answerCallbackQuery(query.id, result.toast || undefined, result.showAlert);
			if (result.keep) this.keepToken(token);
			else this.dropToken(token);
		} catch (error) {
			await this.bot?.answerCallbackQuery(query.id, "실패", true);
			this.eventCtx?.ui.notify(`telegram callback failed: ${errorMessage(error)}`, "warning");
		}
	}

	// ------------------------------------------------------------- Hub: out

	async send(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
		if (!this.bot) throw new Error("telegram bridge is not running");
		// Exact known secrets (our own bot token above all) never ride along, whoever authored the text.
		if (this.cfg.redactTranscript) text = redactSecrets(text);
		text = scrubKnownSecrets(text);
		const markup = options.keyboard?.length ? { inline_keyboard: options.keyboard } : undefined;
		const base = {
			...(markup ? { reply_markup: markup } : {}),
			...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId } : {}),
			...(options.silent ? { disable_notification: true } : {}),
		};
		let firstId: number | undefined;
		if (options.markdown === false) {
			for (const piece of splitHtmlChunks(text, 4000)) {
				const sent = await this.bot.sendSafe(chatId, piece, base);
				firstId ??= sent?.message_id;
			}
			return firstId;
		}
		for (const chunk of toHtmlChunks(text)) {
			const sent = await this.bot.sendSafe(chatId, chunk, base);
			firstId ??= sent?.message_id;
		}
		return firstId;
	}

	/** Send text that already contains Telegram HTML. */
	async sendHtml(chatId: number, html: string, options: SendOptions = {}): Promise<void> {
		await this.send(chatId, html, { ...options, markdown: false });
	}

	async broadcast(text: string, options: SendOptions = {}): Promise<void> {
		for (const chatId of this.chats()) {
			try {
				await this.send(chatId, text, options);
			} catch {
				/* one unreachable chat must not stop the mirror */
			}
		}
	}

	async sendFile(chatId: number, data: Uint8Array, fileName: string, caption?: string): Promise<void> {
		if (!this.bot) throw new Error("telegram bridge is not running");
		// A file leaves this machine for Telegram's servers and the phone: scrub our own credentials.
		caption = caption ? scrubKnownSecrets(caption) : caption;
		if (/\.(png|jpe?g|gif|webp)$/i.test(fileName)) await this.bot.sendPhoto(chatId, data, fileName, caption);
		else await this.bot.sendDocument(chatId, data, fileName, caption);
	}

	async broadcastFile(data: Uint8Array, fileName: string, caption?: string): Promise<void> {
		for (const chatId of this.chats()) {
			try {
				await this.sendFile(chatId, data, fileName, caption);
			} catch {
				/* ignore one failing chat */
			}
		}
	}

	async editKeyboard(chatId: number, messageId: number, text: string, rows: TgInlineKeyboardButton[][]): Promise<boolean> {
		if (!this.bot) return false;
		return this.bot.editSafe(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
	}

	async clearKeyboard(chatId: number, messageId: number): Promise<void> {
		if (!this.bot) return;
		await this.bot.clearKeyboard(chatId, messageId);
	}

	notify(text: string, level: "info" | "warning" = "info"): void {
		this.eventCtx?.ui.notify(text, level);
	}

	observeGoal(result: unknown): string | undefined {
		return this.goalView.observeToolResult(result);
	}

	goalState(): { goal?: GoalSnapshot; focus?: FocusState } {
		const goal = this.goalView.current();
		const focus = this.goalView.focusState();
		return { ...(goal ? { goal } : {}), ...(focus ? { focus } : {}) };
	}

	// -------------------------------------------------------------- Hub: pi

	piContext(): ExtensionContext {
		const ctx = this.eventCtx;
		if (!ctx) throw new Error("pi 세션 컨텍스트가 아직 없어요 — 확장이 로드된 pi에서 시도하세요");
		return ctx;
	}

	tryPiContext(): ExtensionContext | undefined {
		return this.eventCtx;
	}

	async withCommandContext(run: (ctx: ExtensionCommandContext) => Promise<void>): Promise<void> {
		const id = `x${++this.actionSeq}`;
		this.pendingActions.set(id, run);
		// The settler must exist before the marker is sent: pi can execute the /tgexec command
		// synchronously inside sendUserMessage, and then resolve() would be called on nothing.
		let settle!: () => void;
		let fail!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		this.actionSettlers.set(id, { resolve: settle, reject: fail });
		this.pi.sendUserMessage(`/tgexec ${id}`, { expandPromptTemplates: true });
		const timer = setTimeout(() => {
			if (this.actionSettlers.delete(id)) {
				this.pendingActions.delete(id);
				this.dbg("command context timed out", id);
				fail(new Error("pi가 20초 안에 명령 컨텍스트를 주지 않았어요. pi 터미널에서 확장 명령이 동작하는지, pi가 대화 상자를 띄운 채 기다리고 있지 않은지 확인하세요."));
			}
		}, 20_000);
		timer.unref?.();
		try {
			await settled;
		} finally {
			clearTimeout(timer);
			this.pendingActions.delete(id);
			this.actionSettlers.delete(id);
		}
		this.dbg("withCommandContext resolved", id);
	}

	sendToPi(text: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void {
		this.pi.sendUserMessage(text, options);
	}

	isIdle(): boolean {
		const ctx = this.eventCtx;
		return ctx ? ctx.isIdle() : true;
	}

	abortRun(): void {
		this.eventCtx?.abort();
	}

	compactRun(instructions?: string): { ok: boolean; error?: string } {
		const ctx = this.tryPiContext();
		if (!ctx) return { ok: false, error: "pi 세션이 없음" };
		if (!ctx.isIdle()) return { ok: false, error: "실행 중에는 압축할 수 없어요 (/abort 먼저)" };
		try {
			ctx.compact(instructions ? { customInstructions: instructions } : undefined);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	setSessionName(name: string): void {
		this.pi.setSessionName(name);
	}

	sessionName(): string | undefined {
		return this.pi.getSessionName();
	}

	currentModelKey(): string | undefined {
		const model = this.eventCtx?.model;
		return model ? `${model.provider}/${model.id}` : undefined;
	}

	modelId(): string | undefined {
		return this.eventCtx?.model?.id;
	}

	listModels(query?: string): ModelLike[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		const registry: ModelRegistryLike = ctx.modelRegistry;
		const current = this.currentModelKey();
		const needle = query?.trim().toLowerCase();
		const seen = new Set<string>();
		const picked: RegistryModel[] = [];
		const push = (model: RegistryModel | undefined): void => {
			if (!isUsableModel(model)) return;
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) return;
			seen.add(key);
			picked.push(model);
		};
		for (const model of registry.getAvailable()) push(model);
		// pi only calls a model "available" when its provider has credentials it recognises, so a
		// llama.cpp / ollama / lmstudio server on localhost vanishes from that list. Pull those back
		// in from the full registry — a local endpoint needs no provider key at all.
		for (const model of registry.getAll()) {
			if (seen.has(`${model?.provider}/${model?.id}`)) continue;
			if (isUsableModel(model) && modelIsLocal(registry, model)) push(model);
		}
		return picked
			.filter((model) => !needle || `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle))
			.sort((a, b) => {
				const aKey = `${a.provider}/${a.id}`;
				const bKey = `${b.provider}/${b.id}`;
				if (aKey === current) return -1;
				if (bKey === current) return 1;
				// a machine's own models are the ones being reached for, so they come first
				const aLocal = modelIsLocal(registry, a);
				const bLocal = modelIsLocal(registry, b);
				if (aLocal !== bLocal) return aLocal ? -1 : 1;
				return aKey.localeCompare(bKey);
			})
			.map((model) => toModelLike(registry, model, current));
	}

	/** Every usable chat model pi knows about, available or not — the pool a typed reference searches. */
	private allChatModels(registry: ModelRegistryLike): RegistryModel[] {
		const out: RegistryModel[] = [];
		const seen = new Set<string>();
		for (const model of [...registry.getAvailable(), ...registry.getAll()]) {
			if (!isUsableModel(model)) continue;
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(model);
		}
		return out;
	}

	searchModels(text: string, limit: number): ModelLike[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		const registry: ModelRegistryLike = ctx.modelRegistry;
		const current = this.currentModelKey();
		const needle = text.trim().toLowerCase();
		if (!needle) return this.listModels();
		const scored: { model: RegistryModel; score: number }[] = [];
		for (const model of this.allChatModels(registry)) {
			const key = `${model.provider}/${model.id}`.toLowerCase();
			const bareId = model.id.toLowerCase();
			const name = String(model.name ?? "").toLowerCase();
			// provider names never contain "/"; model ids sometimes do (openrouter, cloudflare)
			const afterProvider = key.slice(key.indexOf("/") + 1);
			let score = -1;
			if (key === needle || bareId === needle) score = 0;
			else if (afterProvider === needle) score = 1;
			else if (bareId.startsWith(needle) || afterProvider.startsWith(needle)) score = 2;
			else if (key.includes(needle)) score = 3;
			else if (name.includes(needle)) score = 4;
			if (score < 0) continue;
			scored.push({ model, score });
		}
		scored.sort((a, b) => {
			if (a.score !== b.score) return a.score - b.score;
			const localDelta = Number(modelIsLocal(registry, b.model)) - Number(modelIsLocal(registry, a.model));
			if (localDelta) return localDelta;
			const authDelta = Number(modelNeedsAuth(registry, b.model)) - Number(modelNeedsAuth(registry, a.model));
			if (authDelta) return authDelta;
			return `${a.model.provider}/${a.model.id}`.localeCompare(`${b.model.provider}/${b.model.id}`);
		});
		return scored.slice(0, Math.max(1, limit)).map((entry) => toModelLike(registry, entry.model, current));
	}

	modelProviders(): { provider: string; count: number; local: boolean; needsAuth: boolean }[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		const registry: ModelRegistryLike = ctx.modelRegistry;
		const groups = new Map<string, { count: number; local: boolean; needsAuth: boolean }>();
		for (const model of this.allChatModels(registry)) {
			const provider = String(model.provider ?? "");
			if (!provider) continue;
			const group = groups.get(provider) ?? { count: 0, local: false, needsAuth: modelNeedsAuth(registry, model) };
			group.count += 1;
			group.local = group.local || modelIsLocal(registry, model);
			groups.set(provider, group);
		}
		return [...groups.entries()]
			.map(([provider, group]) => ({ provider, ...group }))
			.sort((a, b) => Number(b.local) - Number(a.local) || Number(a.needsAuth) - Number(b.needsAuth) || b.count - a.count || a.provider.localeCompare(b.provider));
	}

	async setModelByKey(key: string): Promise<{ ok: boolean; error?: string; resolved?: string; custom?: { id: string; template: string } }> {
		const ctx = this.tryPiContext();
		if (!ctx) return { ok: false, error: "pi 세션이 없음" };
		const wanted = key.trim();
		const separator = wanted.indexOf("/");
		const provider = separator > 0 ? wanted.slice(0, separator) : wanted;
		const modelId = separator > 0 ? wanted.slice(separator + 1) : "";
		if (!modelId) return { ok: false, error: `모델 id가 없어요: ${wanted} · provider/id 형태로 입력하세요` };
		const all = this.allChatModels(ctx.modelRegistry);
		const lower = wanted.toLowerCase();
		// pi's model store marks "track the latest" entries with a leading ~; users type the plain id.
		const plain = (value: string): string => value.toLowerCase().replace(/^~/, "");
		const exact = all.find((candidate) => candidate.provider === provider && (candidate.id === modelId || plain(candidate.id) === plain(modelId)));
		// Aggregator ids carry the manufacturer *inside* the id: what looks like the provider in
		// `nvidia/nemotron-3.5-super-vl:free` is part of an openrouter id. Match the whole string.
		const byId = exact ? undefined : all.find((candidate) => plain(candidate.id) === plain(lower));
		const target = exact ?? byId;
		if (target) {
			try {
				const ok = await this.pi.setModel(target as never);
				if (!ok) return { ok: false, error: "🔑 이 provider의 인증 설정이 필요해요 (pi 터미널에서 /login)" };
				return { ok: true, resolved: `${target.provider}/${target.id}` };
			} catch (error) {
				return { ok: false, error: errorMessage(error) };
			}
		}
		// An id pi has never heard of is still usable when a provider can be worked out: take the shape of
		// a sibling model so brand new, renamed, private, or unlisted ids can be typed straight in.
		const known = all.some((candidate) => candidate.provider === provider);
		const aggregator = known ? undefined : inferAggregatorProvider(all);
		const providerForClone = known ? provider : aggregator;
		if (!providerForClone) {
			return { ok: false, error: `🚫 provider를 모르겠어요: ${provider} · /model <provider>/<id> 또는 /model <검색어>로 찾아보세요` };
		}
		// An inferred aggregator keeps the manufacturer: an openrouter id *is* `nvidia/nemotron…:free`.
		const cloneId = providerForClone === provider ? modelId : wanted;
		const siblings = all.filter((candidate) => candidate.provider === providerForClone);
		const family = siblings.find((candidate) => candidate.id.split("/")[0] === cloneId.split("/")[0]);
		const template = family ?? siblings.find((candidate) => candidate.id.includes("/")) ?? siblings[0];
		if (!template) return { ok: false, error: `model not found: ${key} · provider를 모르겠어요 (/model)` };
		try {
			const ok = await this.pi.setModel({ ...template, id: cloneId, name: cloneId } as never);
			if (!ok) return { ok: false, error: "🔑 이 provider의 인증 설정이 필요해요 (pi 터미널에서 /login)" };
			return { ok: true, resolved: `${providerForClone}/${cloneId}`, custom: { id: cloneId, template: `${template.provider}/${template.id}` } };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	thinkingLevel(): string {
		return this.pi.getThinkingLevel();
	}

	setThinkingLevel(level: string): { ok: boolean; error?: string } {
		if (!THINKING_LEVELS.includes(level)) return { ok: false, error: `unknown level: ${level}` };
		try {
			this.pi.setThinkingLevel(level as (typeof THINKING_LEVEL_VALUES)[number]);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	listTools(): { name: string; active: boolean; description?: string }[] {
		const active = new Set(this.pi.getActiveTools());
		const tools: { name: string; active: boolean; description?: string }[] = [];
		// pi owns this list; skip anything malformed instead of crashing the whole keyboard.
		for (const tool of this.pi.getAllTools()) {
			const name = typeof tool?.name === "string" && tool.name ? tool.name : undefined;
			if (!name) continue;
			tools.push({ name, active: active.has(name), description: typeof tool.description === "string" ? tool.description : undefined });
		}
		return tools.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
	}

	setActiveTools(names: string[]): void {
		this.pi.setActiveTools(names);
	}

	listCommands(): { name: string; description?: string; source: string }[] {
		const commands: { name: string; description?: string; source: string }[] = [];
		for (const command of this.pi.getCommands()) {
			const name = typeof command?.name === "string" && command.name ? command.name : undefined;
			if (!name) continue;
			commands.push({ name, description: typeof command.description === "string" ? command.description : undefined, source: String(command.source ?? "pi") });
		}
		return commands;
	}

	contextUsage() {
		return this.tryPiContext()?.getContextUsage();
	}

	sessionInfo(): SessionInfoLike {
		const manager = this.piContext().sessionManager;
		const entries = manager.getEntries();
		return {
			id: manager.getSessionId(),
			file: manager.getSessionFile(),
			dir: manager.getSessionDir(),
			cwd: manager.getCwd(),
			entries: entries.length,
			messages: entries.filter((entry) => entry.type === "message").length,
			startedAt: manager.getHeader()?.timestamp,
		};
	}

	listSessionFiles(limit: number): { path: string; id: string; label: string; current: boolean; project: boolean; projectLabel?: string }[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		const manager = ctx.sessionManager;
		const currentId = manager.getSessionId();
		const dir = manager.getSessionDir();
		const parent = dirname(dir);
		// pi stores sessions per project (<agentDir>/sessions/<project>/x.jsonl). Telegram users want
		// recent sessions the way the terminal picker shows them, so merge sibling projects.
		const root = basename(parent) === "sessions" ? parent : dir;
		const byId = new Map<string, SessionSummary>();
		for (const session of [...listSessions(dir, { limit }), ...listSessions(root, { limit })]) {
			if (!byId.has(session.id)) byId.set(session.id, session);
		}
		const sameProject = (session: SessionSummary) => !session.cwd || sameLocation(session.cwd, manager.getCwd());
		const sessions = [...byId.values()].sort((a, b) => Number(sameProject(b)) - Number(sameProject(a)) || b.modifiedAt - a.modifiedAt);
		return sessions.slice(0, limit).map((session) => {
			const project = sameProject(session);
			return {
				path: session.path,
				id: session.id,
				label: session.name ?? session.firstPrompt?.replace(/\s+/g, " ").slice(0, 60) ?? session.id,
				current: session.id === currentId,
				project,
				projectLabel: project || !session.cwd ? undefined : basename(session.cwd).slice(0, 14),
			};
		});
	}

	listPromptEntries(limit: number): { entryId: string; text: string; timestamp: string }[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		return listPromptEntries(
			ctx.sessionManager.getEntries().map((entry) => ({ id: entry.id, type: entry.type, timestamp: entry.timestamp, message: (entry as { message?: unknown }).message })),
			limit,
		);
	}

	listTreeEntries(limit: number): { entryId: string; label: string; timestamp: string; current: boolean }[] {
		const ctx = this.tryPiContext();
		if (!ctx) return [];
		const leafId = ctx.sessionManager.getLeafId();
		return ctx.sessionManager
			.getEntries()
			.slice(-limit)
			.reverse()
			.map((entry) => {
				const message = (entry as { message?: { role?: string; content?: unknown } }).message;
				const preview = message ? textPreview(message.content) : "";
				const label = preview
					? `${message?.role}: ${preview}`
					: entry.type === "model_change"
						? `model → ${(entry as { modelId?: string }).modelId ?? "?"}`
						: entry.type === "compaction"
							? "compaction"
							: entry.type;
				return { entryId: entry.id, label: truncate(label.replace(/\s+/g, " "), 60), timestamp: entry.timestamp, current: entry.id === leafId };
			});
	}

	async runShell(command: string, timeoutMs = 120_000): Promise<ShellResult> {
		const ctx = this.piContext();
		const windows = process.platform === "win32" && !/^(bash|sh|zsh)\b/.test(command);
		const result = windows
			? await this.pi.exec("powershell", ["-NoProfile", "-Command", command], { cwd: ctx.cwd, timeout: timeoutMs })
			: await this.pi.exec("bash", ["-lc", command], { cwd: ctx.cwd, timeout: timeoutMs });
		return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed, truncated: result.truncated };
	}

	sessionFilePath(): string | undefined {
		return this.tryPiContext()?.sessionManager.getSessionFile();
	}

	uptimeMs(): number {
		return Date.now() - this.startedAt;
	}

	botName(): string {
		return this.bot?.username ? `@${this.bot.username}` : "pi-telegram";
	}

	// --------------------------------------------------------- Hub: tokens

	/**
	 * Callback data for an inline keyboard button. Telegram sends `callback_data` back verbatim,
	 * so the button carries the short server-side token prefixed with `t:`; the lookup helpers
	 * accept either form.
	 */
	createToken(action: CallbackAction, chatId: number, answer?: CallbackEntry["answer"]): string {
		// Random, not sequential: a counter hands anyone who can send a callback the whole button space.
		const token = randomBytes(9).toString("base64url");
		this.tokens.set(token, { action, chatId, createdAt: Date.now(), answer });
		this.pruneTokens();
		return `${CALLBACK_PREFIX}${token}`;
	}

	peekToken(token: string): CallbackEntry | undefined {
		return this.tokens.get(stripCallbackPrefix(token));
	}

	dropToken(token: string): void {
		this.tokens.delete(stripCallbackPrefix(token));
	}

	keepToken(token: string): void {
		const entry = this.tokens.get(stripCallbackPrefix(token));
		if (entry) entry.createdAt = Date.now();
	}

	private pruneTokens(): void {
		const now = Date.now();
		for (const [token, entry] of this.tokens) if (now - entry.createdAt > TOKEN_TTL_MS) this.tokens.delete(token);
		if (this.tokens.size <= MAX_TOKENS) return;
		const oldest = [...this.tokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, this.tokens.size - MAX_TOKENS);
		for (const [token] of oldest) this.tokens.delete(token);
	}

	// ---------------------------------------------------------- Hub: pairing

	noteTelegramInput(text: string): void {
		this.echoes.set(normalize(text), Date.now());
		if (this.echoes.size <= 120) return;
		const cutoff = Date.now() - ECHO_TTL_MS;
		for (const [key, at] of this.echoes) if (at < cutoff) this.echoes.delete(key);
	}

	wasTelegramInput(text: string): boolean {
		const value = normalize(text);
		const at = this.echoes.get(value);
		if (at != null) return Date.now() - at < ECHO_TTL_MS;
		// pi can append its own notes to the text we forwarded ("[Image omitted: …]", pasted files),
		// so a Telegram prompt that only grew a trailing bracketed note is still our own echo.
		for (const [key, when] of this.echoes) {
			if (Date.now() - when > ECHO_TTL_MS) continue;
			if (!value.startsWith(key)) continue;
			const extra = value.slice(key.length).trim();
			if (extra.length && extra.length <= 300 && extra.startsWith("[")) return true;
		}
		return false;
	}

	chats(): number[] {
		return this.cfg.chats.map((chat) => chat.chatId);
	}

	isPaired(chatId: number): boolean {
		return this.cfg.chats.some((chat) => chat.chatId === chatId);
	}

	labelFor(chatId: number): string {
		return this.cfg.chats.find((chat) => chat.chatId === chatId)?.label ?? this.chatTitles.get(chatId) ?? `chat ${chatId}`;
	}

	pairThisChat(chatId: number): void {
		this.addChat(chatId, this.chatTitles.get(chatId) ?? this.cfg.chats.find((chat) => chat.chatId === chatId)?.label ?? `chat ${chatId}`);
	}

	unpairChat(chatId: number): boolean {
		const before = this.cfg.chats.length;
		this.cfg.chats = this.cfg.chats.filter((chat) => chat.chatId !== chatId);
		if (this.cfg.chats.length === before) return false;
		// Revoke every button that chat was ever handed, or a revoked chat keeps live controls.
		for (const [token, entry] of this.tokens) if (entry.chatId === chatId) this.tokens.delete(token);
		this.questions.dropChat(chatId);
		this.drafts.discard(chatId);
		writeConfigNow(this.cfg);
		return true;
	}

	pendingChats(): { chatId: number; code: string; label: string }[] {
		return [...this.pending.values()].map((entry) => ({ chatId: entry.chatId, code: entry.code, label: entry.label }));
	}

	pairedChats(): { chatId: number; label: string; addedAt: number }[] {
		return this.cfg.chats.map((chat) => ({ chatId: chat.chatId, label: chat.label ?? this.chatTitles.get(chat.chatId) ?? `chat ${chat.chatId}`, addedAt: chat.addedAt }));
	}

	verbosity(): 0 | 1 | 2 {
		return this.cfg.verbosity;
	}

	setWorkingNotice(text: string | undefined): void {
		this.refreshStatus(text);
	}

	typing(chatId: number): void {
		void this.bot?.sendChatAction(chatId, "typing");
	}

	/**
	 * Register the "/" autocomplete menu and then read it back. A more specific scope overrides the
	 * default one, so another program using the same bot token can leave *its* command list in front of
	 * the user; detecting that is the only way to explain a menu that doesn't match `/help`.
	 */
	private async registerMenu(bot: TelegramBot): Promise<void> {
		this.menuShadowed = false;
		try {
			await bot.setMyCommands(TELEGRAM_MENU);
			await bot.setMyCommands(TELEGRAM_MENU, { type: "all_private_chats" });
			const served = await bot.getMyCommands({ type: "all_private_chats" });
			// A Bot API that answers with anything other than a list (a proxy, an older endpoint) must
			// not take the bridge down — the menu is a nicety, not a startup requirement.
			this.menuServed = (Array.isArray(served) ? served : []).map((entry) => String(entry?.command ?? "")).filter(Boolean);
			const ours = TELEGRAM_MENU.map((entry) => entry.command);
			this.menuShadowed = ours.some((name) => !this.menuServed.includes(name));
			if (this.menuShadowed) {
				const foreign = this.menuServed.filter((name) => !ours.includes(name));
				this.eventCtx?.ui.notify(
					`telegram 메뉴가 다른 프로그램에 의해 덮어써졌어요 — 같은 토큰을 쓰는 다른 pi/브리지 프로세스를 끄고 /tg menu 로 다시 등록하세요 (다른 목록 ${foreign.length}개: ${foreign.slice(0, 6).join(", ")})`,
					"warning",
				);
			}
		} catch (error) {
			this.dbg("menu registration failed", errorMessage(error));
		}
	}

	refreshMenu(): Promise<{ registered: number; served: string[]; shadowed: boolean }> {
		if (!this.bot) return Promise.resolve({ registered: 0, served: [], shadowed: false });
		return this.registerMenu(this.bot).then(() => ({ registered: TELEGRAM_MENU.length, served: [...this.menuServed], shadowed: this.menuShadowed }));
	}

	bridgeStats(): {
		uptimeMs: number;
		calls: number;
		avgMs: number;
		maxMs: number;
		slow: { method: string; ms: number }[];
		throttled: { at: number; method: string; retryAfter: number }[];
		promptToRunMs: number[];
		polls: { count: number; avgHoldMs: number };
		menu: { registered: number; served: number; shadowed: boolean };
	} {
		const telegram = this.bot?.stats();
		return {
			uptimeMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
			calls: telegram?.count ?? 0,
			avgMs: telegram?.avgMs ?? 0,
			maxMs: telegram?.maxMs ?? 0,
			slow: telegram?.slow ?? [],
			throttled: telegram?.throttled ?? [],
			promptToRunMs: [...this.turnDelays],
			polls: telegram?.polls ?? { count: 0, avgHoldMs: 0 },
			menu: { registered: TELEGRAM_MENU.length, served: this.menuServed.length, shadowed: this.menuShadowed },
		};
	}

	/**
	 * Never swallow a bridge failure: pi shows the message, the stack goes to the log so a real
	 * crash (bad pi object shape, etc.) can actually be diagnosed.
	 */
	reportError(where: string, error: unknown): void {
		const detail = errorMessage(error);
		this.lastError = `${where}: ${detail}`;
		const stack = error instanceof Error ? error.stack : undefined;
		console.error(`pi-telegram: ${where} failed: ${redactSecrets(detail)}${stack ? `\n${redactSecrets(stack)}` : ""}`);
		this.eventCtx?.ui.notify(`pi-telegram ${where} failed: ${redactSecrets(detail)}`, "warning");
		if (this.lastErrorShownAt.get(where) !== Date.now()) {
			this.lastErrorShownAt.set(where, Date.now());
			void this.broadcast(`⚠️ <i>${escapeHtml(redactSecrets(`${where}: ${detail}`))}</i>`, { markdown: false, silent: true }).catch(() => undefined);
		}
	}

	private chatsSummary(): string | undefined {
		const chats = this.pairedChats();
		return chats.length ? chats.map((chat) => `${chat.chatId} ${chat.label}`).join(" | ") : undefined;
	}

	private statusLine(): string {
		return `telegram bridge: ${this.bot ? `connected as ${this.botName()}` : "stopped"} · chats ${this.cfg.chats.length} · detail ${this.cfg.verbosity} · drafts ${this.cfg.streaming ? "on" : "off"}${this.cfg.token ? " · token saved" : ""}`;
	}

	private refreshStatus(running?: string): void {
		const ctx = this.tryPiContext();
		if (!ctx) return;
		ctx.ui.setStatus("telegram-bridge", this.bot ? `🟢 tg ${this.botName()} · ${this.cfg.chats.length} chats${running ? ` · ${running}` : ""}` : "🔴 tg stopped");
	}

	save(): void {
		saveConfig(this.cfg);
	}
}

// ------------------------------------------------------------------ helpers

/** A model as pi's registry hands it over; models.json entries leave `type` unset. */
type RegistryModel = { provider: string; id: string; name?: string; type?: string; baseUrl?: string; contextWindow?: number; reasoning?: boolean };

/** The slice of pi's model registry the bridge needs, so the helpers below stay simple to type. */
type ModelRegistryLike = {
	getAvailable(): RegistryModel[];
	getAll(): RegistryModel[];
	getProvider(provider: string): { baseUrl?: string } | undefined;
	getProviderAuthStatus(provider: string): { configured?: boolean };
};

// models.json entries carry no `type`, so pi's local/custom models must not be judged by it.
function isUsableModel(model: RegistryModel | undefined): model is RegistryModel {
	return !!model && typeof model.id === "string" && model.id !== "" && (!model.type || model.type === "chat");
}

/**
 * Aggregators embed the manufacturer in the model id (`openrouter` ids look like
 * `anthropic/claude-sonnet-4.5`), so an id typed without the provider name can still be resolved.
 * Only inferred when it is unambiguous — a guess would switch a different provider by accident.
 */
function inferAggregatorProvider(models: RegistryModel[]): string | undefined {
	const counts = new Map<string, number>();
	for (const model of models) if (model.id.includes("/")) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	if (counts.has("openrouter")) return "openrouter";
	if (counts.size === 1) return [...counts.keys()][0];
	return undefined;
}

function modelBaseUrl(registry: ModelRegistryLike, model: RegistryModel): string {
	return String(model.baseUrl ?? registry.getProvider(String(model.provider ?? ""))?.baseUrl ?? "");
}

function modelIsLocal(registry: ModelRegistryLike, model: RegistryModel): boolean {
	return isLocalEndpoint(modelBaseUrl(registry, model), String(model.provider ?? ""));
}

/** pi sees no credentials for this provider — a run with it would need pi-side `/login`. */
function modelNeedsAuth(registry: ModelRegistryLike, model: RegistryModel): boolean {
	if (modelIsLocal(registry, model)) return false;
	try {
		return registry.getProviderAuthStatus(String(model.provider ?? "")).configured !== true;
	} catch {
		return false;
	}
}

function toModelLike(registry: ModelRegistryLike, model: RegistryModel, current?: string): ModelLike {
	const key = `${model.provider}/${model.id}`;
	return {
		key,
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		current: key === current,
		local: modelIsLocal(registry, model),
		needsAuth: modelNeedsAuth(registry, model),
	};
}

const LOCAL_HOST_RE =
	/^(localhost|\[[0-9a-f:]*::1\]|::1|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i;
// Providers named after a local runner are local even when the URL is oddly built.
const LOCAL_PROVIDER_RE = /(local|ollama|llama[-_.]?cpp|llama[-_.]?server|lmstudio|vllm|koboldcpp|text[-_.]?generation|oobabooga|jan\b|cactus)/i;

/**
 * Does this model come from a server on the machine or LAN? pi treats such a provider as having no
 * credentials, which hides llama.cpp/ollama/lmstudio models from its "available" list — the bridge
 * needs its own idea of local to keep them reachable.
 */
function isLocalEndpoint(baseUrl: string, provider: string): boolean {
	const raw = baseUrl.trim();
	if (raw) {
		try {
			if (LOCAL_HOST_RE.test(new URL(raw).hostname)) return true;
		} catch {
			if (LOCAL_HOST_RE.test(raw.replace(/^https?:\/\//, "").split(/[/:]/)[0] ?? "")) return true;
		}
	}
	return raw !== "" && LOCAL_PROVIDER_RE.test(`${provider} ${raw}`);
}

function displayName(user: { username?: string; first_name?: string }): string {
	return user.username ? `@${user.username}` : (user.first_name ?? "bot");
}

/** Compare paths across separators and drive letters: pi stores session cwds from any platform. */
type CompactionReason = "manual" | "threshold" | "overflow";

/** pi tells us what triggered a compaction; the chat should not have to guess. */
function compactionReasonLabel(reason: CompactionReason): string {
	if (reason === "manual") return "/compact로 시작";
	return reason === "threshold" ? "컨텍스트 임계값에 도달해서 자동" : "컨텍스트를 넘겨서 자동 복구";
}

function sameLocation(a: string, b: string): boolean {
	const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
}

type SendDetails = { sent: number; error?: string };
type AskDetails = { answered: boolean; answer?: string };

function sendDetails(sent: number, error?: string): SendDetails {
	return { sent, ...(error ? { error } : {}) };
}

function askDetails(answered: boolean, answer?: string): AskDetails {
	return { answered, ...(answer != null ? { answer } : {}) };
}

/** A Telegram file name ends up in the model prompt: keep it to one harmless line. */
function safeFileName(value: string): string {
	const cleaned = value.replace(/[^\p{L}\p{N} .()\[\]_-]+/gu, " ").replace(/\s+/g, " ").trim();
	return cleaned.slice(0, 120) || "attachment";
}

function randomCode(): string {
	// CSPRNG: Math.random() is seedable, and this code is the gate into a shell-capable session.
	return String(randomInt(PAIR_CODE_RANGE[0], PAIR_CODE_RANGE[1]));
}

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function textPreview(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const block of content as { type?: string; text?: string }[]) {
		if (block?.type === "text" && block.text) return block.text;
	}
	return "";
}

const TEXT_EXTENSIONS = /\.(md|txt|json|jsonl|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|h|cpp|hpp|cs|rb|php|sh|ps1|bat|sql|html|css|scss|csv|tsv|xml|ini|cfg|conf|env|diff|patch|log|vue|svelte|lua|pl|r|toml)$/i;

function isTextLike(fileName: string | undefined, mime: string): boolean {
	if (mime.startsWith("text/")) return true;
	if (/^application\/(json|yaml|x-sh|javascript|typescript)/.test(mime)) return true;
	return fileName ? TEXT_EXTENSIONS.test(fileName) : false;
}

/** Split already-rendered HTML on newline boundaries so tags stay intact. */
function splitHtmlChunks(html: string, limit: number): string[] {
	const trimmed = html.replace(/\s+$/g, "");
	if (!trimmed) return [];
	if (trimmed.length <= limit) return [trimmed];
	const pieces: string[] = [];
	let current = "";
	for (const line of trimmed.split("\n")) {
		for (const piece of splitLongLine(line, limit)) {
			if (current.length + piece.length + 1 > limit) {
				if (current) pieces.push(current);
				current = piece;
			} else {
				current = current ? `${current}\n${piece}` : piece;
			}
		}
	}
	if (current) pieces.push(current);
	return pieces;
}
