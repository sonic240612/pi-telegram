/**
 * Persistent bridge configuration.
 * Stored at ~/.pi/agent/telegram.json so it survives `/reload` and pi restarts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 0 = answers only, 1 = answers + per-turn tool summary (default), 2 = full transcript mirror. */
export type Verbosity = 0 | 1 | 2;

export interface TelegramChatRecord {
	chatId: number;
	/** Human label captured when the chat was paired. */
	label?: string;
	addedAt: number;
}

export interface TelegramConfig {
	token?: string;
	chats: TelegramChatRecord[];
	verbosity: Verbosity;
	/** Edit a live draft message while the assistant streams. */
	streaming: boolean;
	/** Last processed getUpdates offset (resumes without replaying). */
	offset?: number;
	/** Send a notice when the bridge connects/disconnects. */
	announce: boolean;
	/**
	 * Scrub credential-looking text out of copies the bridge makes for Telegram — bash output and its
	 * own failure lines. The pi terminal still shows the raw text; only the second copy is cleaned.
	 */
	redactBash: boolean;
	/** Also scrub the mirrored pi transcript. Off by default: detail mode should match the terminal. */
	redactTranscript: boolean;
	/**
	 * One-shot chat notice carried across a session replacement. new/fork/resume dispose the pi
	 * session and re-create this extension, so the instance that started the action is gone before
	 * it can confirm; the fresh instance delivers this notice when it reconnects.
	 */
	pendingNotice?: { text: string; at: number };
}

export const DEFAULT_CONFIG: TelegramConfig = {
	chats: [],
	verbosity: 1,
	streaming: true,
	announce: true,
	redactBash: true,
	redactTranscript: false,
};

/** A queued restart notice older than this is dropped — it belongs to an action long finished. */
export const NOTICE_TTL_MS = 5 * 60 * 1000;

export function configPath(): string {
	return join(getAgentDir(), "telegram.json");
}

/**
 * This file holds the bot token — anyone who can read it can read the mirrored transcript and issue
 * prompts as pi. Keep it owner-only. Windows uses ACLs instead of mode bits, so failures are ignored.
 */
export function hardenFileMode(path: string): void {
	try {
		chmodSync(path, 0o600);
	} catch {
		/* no POSIX permissions on this platform */
	}
}

export function loadConfig(): TelegramConfig {
	const path = configPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	// Repair a config file left world-readable by an older version before we read its contents.
	hardenFileMode(path);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
	const cfg: TelegramConfig = structuredClone(DEFAULT_CONFIG);
	if (!raw || typeof raw !== "object") return cfg;
	const value = raw as Partial<TelegramConfig>;
	if (typeof value.token === "string" && value.token.trim()) cfg.token = value.token.trim();
	if (Array.isArray(value.chats)) {
		cfg.chats = value.chats
			.filter((c): c is TelegramChatRecord => !!c && typeof c.chatId === "number")
			.map((c) => ({ chatId: c.chatId, label: typeof c.label === "string" ? c.label : undefined, addedAt: c.addedAt ?? Date.now() }));
	}
	if (value.verbosity === 0 || value.verbosity === 1 || value.verbosity === 2) cfg.verbosity = value.verbosity;
	if (typeof value.streaming === "boolean") cfg.streaming = value.streaming;
	if (typeof value.announce === "boolean") cfg.announce = value.announce;
	if (typeof value.redactBash === "boolean") cfg.redactBash = value.redactBash;
	if (typeof value.redactTranscript === "boolean") cfg.redactTranscript = value.redactTranscript;
	if (typeof value.offset === "number") cfg.offset = value.offset;
	const notice = value.pendingNotice;
	if (notice && typeof notice.text === "string" && typeof notice.at === "number" && Date.now() - notice.at < NOTICE_TTL_MS) {
		cfg.pendingNotice = { text: notice.text, at: notice.at };
	}
	return cfg;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Atomic-ish write, debounced so bursty updates do not thrash the file. */
export function saveConfig(config: TelegramConfig): void {
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		writeConfigNow(config);
	}, 250);
	saveTimer.unref?.();
}

export function writeConfigNow(config: TelegramConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	// mode on create + chmod after, so a pre-existing temp file cannot keep looser permissions
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	hardenFileMode(tmp);
	renameSync(tmp, path);
	hardenFileMode(path);
}

export function resolveToken(config: TelegramConfig): string | undefined {
	const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	return config.token;
}
