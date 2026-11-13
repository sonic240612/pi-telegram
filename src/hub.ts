/**
 * Shared contracts between the bridge, the outbound mirror, and the command layer.
 * Its own module so those modules never import each other.
 */
import type { ContextUsage, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramConfig } from "./config.ts";
import type { GoalSnapshot, FocusState } from "./goal.ts";
import type { TgInlineKeyboardButton } from "./telegram.ts";

export interface SendOptions {
	/** Treat the text as Markdown and convert it to Telegram HTML. Default true. */
	markdown?: boolean;
	keyboard?: TgInlineKeyboardButton[][];
	replyToMessageId?: number;
	silent?: boolean;
}

export type CallbackActionKind =
	| "model:pick"
	| "model:provider"
	| "thinking:pick"
	| "resume:pick"
	| "fork:pick"
	| "tree:pick"
	| "tools:toggle"
	| "tools:reset"
	| "commands:pick"
	| "list:page"
	| "menu:open"
	| "chat:unpair"
	| "ask:answer"
	| "askq:option"
	| "askq:multi"
	| "askq:text"
	| "askq:submit"
	| "askq:cancel"
	| "noop";

export interface CallbackAction {
	kind: CallbackActionKind;
	value?: string;
	/** Extra payload kept server-side; callback_data carries only a short token. */
	blob?: unknown;
}

export interface CallbackEntry {
	action: CallbackAction;
	chatId: number;
	createdAt: number;
	/** Set on ask:answer buttons. */
	answer?: {
		resolve: (value: string) => void;
		messageId?: number;
	};
}

/** Which list a paginated keyboard is showing. */
export type ListKind = "model" | "model:providers" | "resume" | "fork" | "tree" | "commands" | "skills" | "tools";

/**
 * Every button we build carries `t:<token>` in callback_data — the token is the only thing
 * Telegram echoes back, and the action itself stays server-side.
 */
export const CALLBACK_PREFIX = "t:";

export function stripCallbackPrefix(data: string): string {
	return data.startsWith(CALLBACK_PREFIX) ? data.slice(CALLBACK_PREFIX.length) : data;
}

export interface ListSpec {
	list: ListKind;
	args: string;
	page: number;
}

/** Minimal model view so the command layer never imports pi model types. */
export interface ModelLike {
	key: string;
	provider: string;
	id: string;
	name: string;
	contextWindow?: number;
	reasoning?: boolean;
	current: boolean;
	/** Served from localhost or the LAN (llama.cpp, ollama, lmstudio …) — no provider key needed. */
	local?: boolean;
	/** pi sees no credentials for this provider, so a run would need `/login` first. */
	needsAuth?: boolean;
}

export interface PiCommandLike {
	name: string;
	description?: string;
	source: string;
}

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	truncated: boolean;
}

export interface SessionInfoLike {
	id: string;
	file?: string;
	dir: string;
	cwd: string;
	entries: number;
	messages: number;
	startedAt?: string;
}

export interface CallbackResult {
	/** Toast shown on the pressed button. */
	toast?: string;
	/** Show the toast as a modal alert. */
	showAlert?: boolean;
	/** Suppress default cleanup (used by ask:answer). */
	keep?: boolean;
}

export interface Hub {
	readonly cfg: TelegramConfig;
	save(): void;

	chats(): number[];
	labelFor(chatId: number): string;
	/** Send a message; resolves to the telegram message id when one exists (needed to edit it later). */
	send(chatId: number, text: string, options?: SendOptions): Promise<number | undefined>;
	broadcast(text: string, options?: SendOptions): Promise<void>;
	sendFile(chatId: number, data: Uint8Array, fileName: string, caption?: string): Promise<void>;
	broadcastFile(data: Uint8Array, fileName: string, caption?: string): Promise<void>;
	editKeyboard(chatId: number, messageId: number, text: string, rows: TgInlineKeyboardButton[][]): Promise<boolean>;
	/** Take the buttons off a message we no longer have actions for. */
	clearKeyboard(chatId: number, messageId: number): Promise<void>;
	/** A line for the pi operator's terminal — chat-side events worth seeing at the keyboard. */
	notify(text: string, level?: "info" | "warning"): void;

	// pi-side actions, implemented by the bridge
	piContext(): ExtensionContext;
	tryPiContext(): ExtensionContext | undefined;
	withCommandContext(run: (ctx: ExtensionCommandContext) => Promise<void>): Promise<void>;
	/**
	 * Queue a chat notice for the bridge instance that exists after a session replacement.
	 * /new, /resume and /fork dispose the pi session and re-create the extension, so the instance
	 * that ran the action cannot confirm it.
	 */
	notifyAfterRestart(text: string): number;
	clearPendingNotice(at?: number): void;
	sendToPi(text: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
	isIdle(): boolean;
	abortRun(): void;
	compactRun(instructions?: string): { ok: boolean; error?: string };
	setSessionName(name: string): void;
	sessionName(): string | undefined;
	currentModelKey(): string | undefined;
	listModels(query?: string): ModelLike[];
	/**
	 * Rank every model pi knows about (not only the ones it considers available) against a typed
	 * reference, so `/model openrouter/anthropic/claude-…` works even when the provider has hundreds
	 * of entries that nobody can page through.
	 */
	searchModels(text: string, limit: number): ModelLike[];
	/** Providers with their model counts, for drilling into a big provider. */
	modelProviders(): { provider: string; count: number; local: boolean; needsAuth: boolean }[];
	setModelByKey(key: string): Promise<{ ok: boolean; error?: string; resolved?: string; custom?: { id: string; template: string } }>;
	thinkingLevel(): string;
	setThinkingLevel(level: string): { ok: boolean; error?: string };
	listTools(): { name: string; active: boolean; description?: string }[];
	setActiveTools(names: string[]): void;
	listCommands(): PiCommandLike[];
	contextUsage(): ContextUsage | undefined;
	sessionInfo(): SessionInfoLike;
	listSessionFiles(limit: number): { path: string; id: string; label: string; current: boolean; project: boolean; projectLabel?: string }[];
	listPromptEntries(limit: number): { entryId: string; text: string; timestamp: string }[];
	listTreeEntries(limit: number): { entryId: string; label: string; timestamp: string; current: boolean }[];
	runShell(command: string, timeoutMs?: number): Promise<ShellResult>;
	sessionFilePath(): string | undefined;
	/**
	 * Fold a tool result into the goal view (pi-goal-x interop). Returns chat HTML when the change is
	 * news — a new goal, a status change, or task progress — and nothing for bookkeeping mutations.
	 */
	observeGoal(result: unknown): string | undefined;
	/** What the bridge knows about the goal this session is chasing. */
	goalState(): { goal?: GoalSnapshot; focus?: FocusState };
	uptimeMs(): number;
	botName(): string;
	modelId(): string | undefined;

	// inline keyboard tokens
	createToken(action: CallbackAction, chatId: number, answer?: CallbackEntry["answer"]): string;
	peekToken(token: string): CallbackEntry | undefined;
	dropToken(token: string): void;
	keepToken(token: string): void;

	// echo suppression: text typed in Telegram must not be echoed back to Telegram
	noteTelegramInput(text: string): void;
	wasTelegramInput(text: string): boolean;

	// pairing
	pairThisChat(chatId: number): void;
	unpairChat(chatId: number): boolean;
	pendingChats(): { chatId: number; code: string; label: string }[];
	pairedChats(): { chatId: number; label: string; addedAt: number }[];
	restartBridge(): void;

	verbosity(): 0 | 1 | 2;
	setWorkingNotice(text: string | undefined): void;
	/** Transient "입력 중…" hint for one chat; fire and forget. */
	typing(chatId: number): void;
	/**
	 * Tell the bridge that pi is rebuilding its context (compaction, branch summary). While busy, chat
	 * prompts are parked locally and replayed afterwards, because pi rejects prompts during that window.
	 */
	setContextBusy(busy: boolean, reason: string): void;
	/** Re-register the "/" autocomplete menu and report what telegram actually serves back. */
	refreshMenu(): Promise<{ registered: number; served: string[]; shadowed: boolean }>;
	/** Latency bookkeeping for `/tg stats` — tells pi-side slowness from telegram-side slowness. */
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
	};
	/** Surface an internal failure on the pi side (and in logs) instead of swallowing it. */
	reportError(where: string, error: unknown): void;
}
