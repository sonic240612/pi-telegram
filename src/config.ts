/**
 * Persistent bridge configuration.
 * Stored at ~/.pi/agent/telegram.json so it survives `/reload` and pi restarts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Lang } from "./i18n.ts";
import { isLang } from "./i18n.ts";

/** 0 = answers only, 1 = answers + per-turn tool summary (default), 2 = full transcript mirror. */
export type Verbosity = 0 | 1 | 2;

export interface TelegramChatRecord {
	chatId: number;
	/** Human label captured when the chat was paired. */
	label?: string;
	addedAt: number;
	/** What this chat chose with /tg lang. Beats every other setting for that chat. */
	lang?: Lang;
	/** What Telegram last told us the user's client speaks, remembered so a restart keeps it. */
	tgLang?: Lang;
}

export interface TelegramConfig {
	token?: string;
	chats: TelegramChatRecord[];
	verbosity: Verbosity;
	/** Edit a live draft message while the assistant streams. */
	streaming: boolean;
	/**
	 * Detail level 1 keeps one "이번 턴" message per turn and edits it as tools run, the way the pi
	 * terminal updates its status line. Turn it off to get only the finished summary at turn end.
	 */
	activityLive: boolean;
	/** Last processed getUpdates offset (resumes without replaying). */
	offset?: number;
	/**
	 * Language of everything the bridge itself says, for every chat that has not chosen its own. Left
	 * unset, each chat follows the language Telegram reports for that user's client.
	 */
	language?: Lang;
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
	pendingNotice?: { ko: string; en: string; at: number };
}

export const DEFAULT_CONFIG: TelegramConfig = {
	chats: [],
	verbosity: 1,
	streaming: true,
	activityLive: true,
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
			.map((c) => ({
				chatId: c.chatId,
				label: typeof c.label === "string" ? c.label : undefined,
				addedAt: c.addedAt ?? Date.now(),
				lang: isLang((c as Partial<TelegramChatRecord>).lang) ? (c as Partial<TelegramChatRecord>).lang : undefined,
				tgLang: isLang((c as Partial<TelegramChatRecord>).tgLang) ? (c as Partial<TelegramChatRecord>).tgLang : undefined,
			}));
	}
	// An install that already works keeps speaking the language it always used. Auto-detection is only a
	// default for chats paired from now on, so upgrading never changes the words on someone's phone.
	cfg.language = inheritedLanguage(cfg.chats, value.language);
	if (value.verbosity === 0 || value.verbosity === 1 || value.verbosity === 2) cfg.verbosity = value.verbosity;
	if (typeof value.streaming === "boolean") cfg.streaming = value.streaming;
	if (typeof value.activityLive === "boolean") cfg.activityLive = value.activityLive;
	if (typeof value.announce === "boolean") cfg.announce = value.announce;
	if (typeof value.redactBash === "boolean") cfg.redactBash = value.redactBash;
	if (typeof value.redactTranscript === "boolean") cfg.redactTranscript = value.redactTranscript;
	if (typeof value.offset === "number") cfg.offset = value.offset;
	const notice = value.pendingNotice as { ko?: string; en?: string; text?: string; at?: number } | undefined;
	// Older installs wrote one string in one language; keep those readable and let the new shape carry
	// both, because the notice is broadcast to every chat and each one reads it in its own language.
	const ko = typeof notice?.ko === "string" ? notice.ko : typeof notice?.text === "string" ? notice.text : "";
	const en = typeof notice?.en === "string" ? notice.en : ko;
	if (ko && typeof notice?.at === "number" && Date.now() - notice.at < NOTICE_TTL_MS) {
		cfg.pendingNotice = { ko, en, at: notice.at };
	}
	return cfg;
}

/**
 * The language an install starts with: what the config file says when it says anything, otherwise Korean
 * for an install that already has chats — those people have never seen English from this bridge —
 * otherwise nothing, which means "ask telegram what each chat's client speaks".
 */
export function inheritedLanguage(chats: unknown[], written: unknown): Lang | undefined {
	return isLang(written) ? written : chats.length > 0 ? "ko" : undefined;
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
