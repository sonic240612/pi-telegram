/**
 * Persistent bridge configuration.
 * Stored at ~/.pi/agent/telegram.json so it survives `/reload` and pi restarts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
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
	/** What kind of chat this is, as Telegram told us when it was paired. Groups need extra rules. */
	type?: "private" | "group" | "supergroup" | "channel";
	/** The Telegram account that asked for this chat. In a group, only this one speaks to pi. */
	ownerUserId?: number;
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
	 * Whether a chat that is not a one-to-one private chat may be paired at all. Off by default: in a
	 * group, whoever knows the pairing code — any member — would open pi and this machine to the room.
	 */
	allowGroups: boolean;
	/** Whether /bash may run commands at all. On by default; turn it off on a shared or work machine. */
	allowShell: boolean;
	/** Mask credential-looking strings in the transcript /export sends to the phone. */
	redactOnExport: boolean;
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
	allowGroups: false,
	allowShell: true,
	redactOnExport: true,
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
const hardenedPaths = new Set<string>();
let cachedAccount: string | undefined;

/**
 * The two `icacls` calls, as argument arrays — never through a shell, so a path with odd characters
 * cannot turn into a command. Owner grant first, inheritance removal second: the other order could
 * leave the file readable by nobody if the grant fails.
 */
export function winAclArgs(path: string, account: string): string[][] {
	return [
		[path, "/grant:r", `${account}:F`],
		[path, "/inheritance:r"],
	];
}

export function hardenFileMode(path: string): void {
	if (process.platform === "win32") {
		// Windows keeps secrets behind ACLs, and chmod is a no-op there. A file created by this process
		// usually inherits read access from its folder, which for a profile directory is too wide.
		if (hardenedPaths.has(path)) return;
		hardenedPaths.add(path);
		void hardenWithAcl(path);
		return;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		/* no POSIX permissions on this platform */
	}
}

async function hardenWithAcl(path: string): Promise<void> {
	try {
		const { execFile } = await import("node:child_process");
		const run = (args: string[]) =>
			new Promise<void>((resolve) => execFile("icacls", args, { windowsHide: true }, () => resolve()));
		if (cachedAccount === undefined) {
			cachedAccount = await new Promise<string>((resolve) =>
				execFile("whoami", [], { windowsHide: true }, (_error, out) => resolve(String(out ?? "").trim())),
			);
		}
		if (!cachedAccount) return;
		for (const args of winAclArgs(path, cachedAccount)) await run(args);
	} catch {
		/* a machine without icacls, or an account we cannot name: leave the file as it is */
	}
}

export function loadConfig(): TelegramConfig {
	const path = configPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	// Repair a config file left world-readable by an older version before we read its contents.
	hardenFileMode(path);
	diskStamp = fileStamp(path);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
	return parseConfig(raw);
}

/** Read a config object from anything. Used for the file and for what another window wrote. */
export function parseConfig(raw: unknown): TelegramConfig {
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
				type: c.type === "private" || c.type === "group" || c.type === "supergroup" || c.type === "channel" ? c.type : undefined,
				ownerUserId: typeof c.ownerUserId === "number" ? c.ownerUserId : undefined,
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
	if (typeof value.allowGroups === "boolean") cfg.allowGroups = value.allowGroups;
	if (typeof value.allowShell === "boolean") cfg.allowShell = value.allowShell;
	if (typeof value.redactOnExport === "boolean") cfg.redactOnExport = value.redactOnExport;
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

/**
 * The switches a person is expected to edit by hand. They belong to the file; chats, offset and the
 * queued notice belong to the running window. On write, the file's switches win, so an edit made
 * while pi was running is not silently overwritten by the bridge saving something else.
 */
export const SWITCH_KEYS = ["verbosity", "streaming", "activityLive", "announce", "redactBash", "redactTranscript", "allowGroups", "allowShell", "redactOnExport"] as const;

let diskStamp = 0;

/** mtime of telegram.json the last time this process read or wrote it. */
function fileStamp(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

export function mergeSwitchesFrom(target: TelegramConfig, source: TelegramConfig): void {
	for (const key of SWITCH_KEYS) {
		const value = source[key];
		if (value !== undefined) (target as unknown as Record<string, unknown>)[key] = value;
	}
}

export function writeConfigNow(config: TelegramConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	// A switch edited by hand while pi ran must survive this write. But a switch this window set a
	// moment ago must not be reverted by an older copy of the file — so merge only when the file
	// changed since this process last touched it.
	try {
		if (existsSync(path) && fileStamp(path) !== diskStamp) mergeSwitchesFrom(config, parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown));
	} catch {
		/* an unreadable or half-written file: write what we have rather than refusing to save */
	}
	const tmp = `${path}.tmp`;
	// mode on create + chmod after, so a pre-existing temp file cannot keep looser permissions
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	hardenFileMode(tmp);
	renameSync(tmp, path);
	hardenFileMode(path);
	diskStamp = fileStamp(path);
}

export function resolveToken(config: TelegramConfig): string | undefined {
	const fromEnv = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	return config.token;
}
