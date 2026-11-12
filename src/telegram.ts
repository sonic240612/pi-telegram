/**
 * Minimal Telegram Bot API client. No dependencies: global fetch + FormData.
 * Requests are serialized with a small delay, and 429 responses honour `retry_after`.
 */
import { scrubKnownSecrets } from "./format.ts";

export interface TgUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}

export interface TgChat {
	id: number;
	type?: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface TgPhotoSize {
	file_id: string;
	file_unique_id?: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TgDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TgEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
}

export interface TgMessage {
	message_id: number;
	from?: TgUser;
	sender_chat?: TgChat;
	chat: TgChat;
	date: number;
	text?: string;
	caption?: string;
	photo?: TgPhotoSize[];
	document?: TgDocument;
	audio?: { file_id: string; file_name?: string; mime_type?: string; duration?: number };
	voice?: { file_id: string; mime_type?: string; duration?: number };
	video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	video_note?: { file_id: string };
	animation?: { file_id: string; file_name?: string; mime_type?: string };
	sticker?: { file_id: string; emoji?: string };
	reply_to_message?: TgMessage;
	entities?: TgEntity[];
	caption_entities?: TgEntity[];
	contact?: { phone_number: string };
	location?: { latitude: number; longitude: number };
	new_chat_title?: string;
}

export interface TgCallbackQuery {
	id: string;
	from: TgUser;
	message?: TgMessage;
	data?: string;
	chat_instance: string;
}

export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	edited_message?: TgMessage;
	channel_post?: TgMessage;
	callback_query?: TgCallbackQuery;
}

export interface TgInlineKeyboardButton {
	text: string;
	callback_data?: string;
	url?: string;
}

export interface TgInlineKeyboardMarkup {
	inline_keyboard: TgInlineKeyboardButton[][];
}

/**
 * Telegram rejects a button whose text is longer than 64 characters, which would fail the whole
 * keyboard — so clamp at the boundary instead. `callback_data` is never touched: ours are opaque
 * tokens that stay well under its own 64-byte cap.
 */
function clampMarkup(markup: TgInlineKeyboardMarkup | undefined): TgInlineKeyboardMarkup | undefined {
	if (!markup) return undefined;
	return {
		inline_keyboard: markup.inline_keyboard.map((row) =>
			row.map((button) => ({ ...button, text: button.text.length > 64 ? `${button.text.slice(0, 61)}…` : button.text })),
		),
	};
}

export interface SendMessageOptions {
	parse_mode?: "HTML";
	disable_web_page_preview?: boolean;
	reply_markup?: TgInlineKeyboardMarkup;
	reply_to_message_id?: number;
	disable_notification?: boolean;
}

export class TelegramError extends Error {
	readonly method: string;
	readonly code: number;
	readonly retryAfter?: number;

	constructor(method: string, code: number, message: string, retryAfter?: number) {
		super(`${method}: ${message} (${code})`);
		this.method = method;
		this.code = code;
		this.retryAfter = retryAfter;
		this.name = "TelegramError";
	}
}

const API_ROOT = "https://api.telegram.org";

export class TelegramBot {
	private queue: Promise<unknown> = Promise.resolve();
	/**
	 * Long polling lives on its own lane. A `getUpdates` call can stay open for 25 seconds, and if it
	 * shared the send queue every answer would wait for that poll to expire — which is exactly how a
	 * bridge ends up replying many seconds after pi finished.
	 */
	private pollQueue: Promise<unknown> = Promise.resolve();
	/**
	 * Fire-and-forget niceties ("입력 중…") get a third lane: a typing hint must never sit in front
	 * of an answer, and it is worth dropping rather than delaying one.
	 */
	private actQueue: Promise<unknown> = Promise.resolve();
	private lastPollAt = 0;
	private lastRequestAt = 0;
	private lastActAt = 0;
	private throttleUntil = 0;
	private callCount = 0;
	private callTotalMs = 0;
	private callMaxMs = 0;
	private recentSlow: { method: string; ms: number }[] = [];
	private recentThrottle: { at: number; method: string; retryAfter: number }[] = [];
	private pollCount = 0;
	private pollTotalMs = 0;
	/** Bot identity, filled by getMe(). */
	username?: string;
	firstName?: string;

	readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	get apiRoot(): string {
		return this.checkedApiRoot();
	}

	/**
	 * The bot token travels inside the request path, so the host we point at receives it. Refuse to
	 * send it in plain http to anywhere that is not loopback (the offline tests run a local mock), and
	 * say out loud when a third-party host is being trusted.
	 */
	private checkedApiRoot(): string {
		const configured = process.env.TELEGRAM_API_ROOT?.trim();
		if (!configured) return API_ROOT;
		let url: URL;
		try {
			url = new URL(configured);
		} catch {
			throw new TelegramError("config", 0, "TELEGRAM_API_ROOT is not a valid URL");
		}
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
		if (url.protocol !== "https:" && !loopback) {
			throw new TelegramError(
				"config",
				0,
				`TELEGRAM_API_ROOT must be https (got ${url.protocol}//${url.hostname}) — the bot token would leave this machine in the clear`,
			);
		}
		if (url.hostname !== "api.telegram.org" && !loopback && !this.foreignHostWarned) {
			this.foreignHostWarned = true;
			console.error(`[pi-telegram] TELEGRAM_API_ROOT points at ${url.hostname} — that host receives the bot token.`);
		}
		return configured.replace(/\/+$/, "");
	}

	private foreignHostWarned = false;

	/** Never let the token appear in an error message: fetch/undici can quote the request URL. */
	private scrub(text: string): string {
		return this.token ? text.split(this.token).join("[redacted token]") : text;
	}

	/**
	 * The last gate before anything leaves for Telegram. Exact known secrets (this bot's token above
	 * all) are removed whatever the caller meant to send: an answer that quotes the token, a bash log,
	 * a streaming draft. Pattern-based scrubbing stays a policy decision in the layer above.
	 */
	private out(text: string): string {
		return this.scrub(scrubKnownSecrets(text));
	}

	/** Serialize all API calls; Telegram rate limits are per-bot and forgiving of a queue. */
	api<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const run = this.queue.then(async () => {
			const gap = Date.now() - this.lastRequestAt;
			if (gap < 60) await sleep(60 - gap);
			this.lastRequestAt = Date.now();
			return this.requestJson<T>(method, params);
		});
		// Keep the chain alive even when a call rejects.
		this.queue = run.catch(() => undefined);
		return run;
	}

	apiMultipart<T>(method: string, form: FormData): Promise<T> {
		const run = this.queue.then(async () => {
			const gap = Date.now() - this.lastRequestAt;
			if (gap < 60) await sleep(60 - gap);
			this.lastRequestAt = Date.now();
			return this.send<T>(method, form as unknown as BodyInit, undefined, 90_000);
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Polling lane: at most one poll is in flight (the bridge loop guarantees that). */
	private poll<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const run = this.pollQueue.then(async () => {
			const gap = Date.now() - this.lastPollAt;
			if (gap < 60) await sleep(60 - gap);
			this.lastPollAt = Date.now();
			return this.requestJson<T>(method, params, 35_000);
		});
		this.pollQueue = run.catch(() => undefined);
		return run;
	}

	/** Auxiliary lane for hints like `typing`; dropped while telegram is throttling us. */
	private actQueueDepth = 0;

	private act<T>(method: string, params: Record<string, unknown>): Promise<T> {
		// Niceties are cheap to drop: if the lane is already backed up, do not add to it.
		if (this.actQueueDepth >= 2 || this.throttleUntil > Date.now()) {
			return Promise.reject(new TelegramError(method, 429, "auxiliary lane busy", 1));
		}
		// Never queue a nicety: send it now or drop it, so a hint can never sit in front of an answer.
		if (Date.now() - this.lastActAt < 2500) return Promise.reject(new TelegramError(method, 429, "auxiliary hint dropped", 1));
		this.actQueueDepth += 1;
		const run = this.actQueue.then(async () => {
			this.lastActAt = Date.now();
			return this.requestJson<T>(method, params);
		});
		this.actQueue = run.finally(() => {
			this.actQueueDepth -= 1;
		}).catch(() => undefined);
		return run;
	}

	/** Latency of the calls we make, for `/tg stats` — the quickest way to tell pi from telegram. */
	stats(): {
		count: number;
		avgMs: number;
		maxMs: number;
		slow: { method: string; ms: number }[];
		throttled: { at: number; method: string; retryAfter: number }[];
		polls: { count: number; avgHoldMs: number };
	} {
		return {
			count: this.callCount,
			avgMs: this.callCount ? Math.round(this.callTotalMs / this.callCount) : 0,
			maxMs: this.callMaxMs,
			slow: [...this.recentSlow],
			throttled: [...this.recentThrottle],
			// A long poll is open on purpose (up to 25s), so counting it as "latency" would be a lie.
			polls: { count: this.pollCount, avgHoldMs: this.pollCount ? Math.round(this.pollTotalMs / this.pollCount) : 0 },
		};
	}

	private recordCall(method: string, ms: number): void {
		if (method === "getUpdates") {
			this.pollCount += 1;
			this.pollTotalMs += ms;
			return;
		}
		this.callCount += 1;
		this.callTotalMs += ms;
		this.callMaxMs = Math.max(this.callMaxMs, ms);
		if (ms > 900) {
			this.recentSlow.push({ method, ms });
			if (this.recentSlow.length > 8) this.recentSlow.shift();
		}
	}

	private async requestJson<T>(method: string, params: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
		const startedAt = Date.now();
		try {
			const result = await this.send<T>(method, JSON.stringify(params), "application/json", timeoutMs);
			this.recordCall(method, Date.now() - startedAt);
			return result;
		} catch (error) {
			this.recordCall(method, Date.now() - startedAt);
			if (error instanceof TelegramError && error.retryAfter && error.retryAfter <= 15) {
				this.throttleUntil = Date.now() + (error.retryAfter + 0.5) * 1000;
				this.recentThrottle.push({ at: Date.now(), method, retryAfter: error.retryAfter });
				if (this.recentThrottle.length > 8) this.recentThrottle.shift();
				await sleep((error.retryAfter + 0.3) * 1000);
				return this.send<T>(method, JSON.stringify(params), "application/json", timeoutMs);
			}
			throw error;
		}
	}

	private async send<T>(method: string, body: BodyInit, contentType: string | undefined, timeoutMs: number): Promise<T> {
		// A wedged request would otherwise park the whole send lane, so every call has a budget.
		let response: Response;
		try {
			response = await fetch(`${this.apiRoot}/bot${this.token}/${method}`, {
				method: "POST",
				body,
				signal: AbortSignal.timeout(timeoutMs),
				...(contentType ? { headers: { "content-type": contentType } } : {}),
			});
		} catch (error) {
			// undici can name the failing URL, which carries the token — keep it out of the message.
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			throw new TelegramError(method, 0, `network failure — ${this.scrub(reason)}`);
		}
		let payload: { ok: boolean; description?: string; result?: T; parameters?: { retry_after?: number } };
		try {
			payload = (await response.json()) as typeof payload;
		} catch {
			throw new TelegramError(method, response.status, `non-JSON response (HTTP ${response.status})`);
		}
		if (!payload.ok) {
			throw new TelegramError(method, response.status, this.scrub(payload.description ?? "request failed"), payload.parameters?.retry_after);
		}
		return payload.result as T;
	}

	async getMe(): Promise<TgUser> {
		const me = await this.api<TgUser>("getMe");
		this.username = me.username;
		this.firstName = me.first_name;
		return me;
	}

	getUpdates(offset: number, timeout = 25): Promise<TgUpdate[]> {
		return this.poll<TgUpdate[]>("getUpdates", {
			offset,
			timeout,
			allowed_updates: ["message", "edited_message", "channel_post", "callback_query"],
		});
	}

	/** Long-poll with a short timeout; used by the loop and by `/ping`. */
	getUpdatesShort(offset: number): Promise<TgUpdate[]> {
		return this.apiRawGetUpdates(offset);
	}

	private apiRawGetUpdates(offset: number): Promise<TgUpdate[]> {
		return this.poll<TgUpdate[]>("getUpdates", { offset, timeout: 5, allowed_updates: ["message", "edited_message", "channel_post", "callback_query"] });
	}

	sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<TgMessage> {
		const { reply_markup, ...rest } = options;
		return this.api<TgMessage>("sendMessage", {
			chat_id: chatId,
			text: this.out(text),
			...rest,
			reply_markup: clampMarkup(reply_markup),
			disable_web_page_preview: options.disable_web_page_preview ?? true,
		});
	}

	/** Long messages are retried as plain text when HTML parsing is rejected. */
	async sendSafe(chatId: number, text: string, options: SendMessageOptions = {}): Promise<TgMessage | undefined> {
		try {
			return await this.sendMessage(chatId, text, { parse_mode: "HTML", ...options });
		} catch (error) {
			if (error instanceof TelegramError && /can't parse/i.test(error.message)) {
				return await this.sendMessage(chatId, stripHtml(text), { ...options, parse_mode: undefined });
			}
			throw error;
		}
	}

	editing: Record<string, Promise<unknown>> = {};

	/** Take the buttons away from a message whose callbacks are dead — stale keys invite endless taps. */
	async clearKeyboard(chatId: number, messageId: number): Promise<void> {
		try {
			await this.api<unknown>("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
		} catch {
			// too old to edit, or already cleared: nothing to do
		}
	}

	editMessageText(chatId: number, messageId: number, text: string, options: SendMessageOptions = {}): Promise<TgMessage> {
		const { reply_markup, ...rest } = options;
		return this.api<TgMessage>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text: this.out(text),
			...rest,
			reply_markup: clampMarkup(reply_markup),
			disable_web_page_preview: options.disable_web_page_preview ?? true,
		});
	}

	async editSafe(chatId: number, messageId: number, text: string, options: SendMessageOptions = {}): Promise<boolean> {
		try {
			await this.editMessageText(chatId, messageId, text, { parse_mode: "HTML", ...options });
			return true;
		} catch (error) {
			if (error instanceof TelegramError) {
				if (/message is not modified/i.test(error.message)) return true;
				if (/can't parse/i.test(error.message)) {
					try {
						await this.editMessageText(chatId, messageId, stripHtml(text), { ...options, parse_mode: undefined });
						return true;
					} catch {
						return false;
					}
				}
				if (/message to edit not found/i.test(error.message)) return false;
			}
			throw error;
		}
	}

	deleteMessage(chatId: number, messageId: number): Promise<boolean> {
		return this.api<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => false);
	}

	sendChatAction(chatId: number, action = "typing"): Promise<void> {
		return this.act<void>("sendChatAction", { chat_id: chatId, action }).catch(() => undefined);
	}

	sendDocument(chatId: number, file: Uint8Array, fileName: string, caption?: string): Promise<TgMessage> {
		const form = new FormData();
		form.append("chat_id", String(chatId));
		form.append("document", new Blob([toBytes(file)]), fileName);
		if (caption) {
			form.append("caption", this.out(caption));
			form.append("parse_mode", "HTML");
		}
		form.append("disable_notification", "false");
		return this.apiMultipart<TgMessage>("sendDocument", form);
	}

	sendPhoto(chatId: number, file: Uint8Array, fileName: string, caption?: string): Promise<TgMessage> {
		const form = new FormData();
		form.append("chat_id", String(chatId));
		form.append("photo", new Blob([toBytes(file)]), fileName);
		if (caption) {
			form.append("caption", this.out(caption));
			form.append("parse_mode", "HTML");
		}
		return this.apiMultipart<TgMessage>("sendPhoto", form);
	}

	getFile(fileId: string): Promise<{ file_path?: string }> {
		return this.api<{ file_path?: string }>("getFile", { file_id: fileId });
	}

	async downloadFile(filePath: string, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
		// The path comes from the API, so treat it as untrusted input: no traversal, no absolute paths.
		const safe = String(filePath).replace(/^\/+/, "");
		if (!safe || safe.includes("..") || safe.includes("\\")) throw new TelegramError("downloadFile", 400, "telegram returned an unusable file path");
		let response: Response;
		try {
			response = await fetch(`${this.apiRoot}/file/bot${this.token}/${encodeURI(safe)}`, { signal: AbortSignal.timeout(60_000) });
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			throw new TelegramError("downloadFile", 0, `network failure — ${this.scrub(reason)}`);
		}
		if (!response.ok) throw new TelegramError("downloadFile", response.status, `download failed (HTTP ${response.status})`);
		// Fail before buffering a file we would throw away anyway.
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new TelegramError("downloadFile", 413, `file larger than ${maxBytes} bytes`);
		}
		const buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > maxBytes) throw new TelegramError("downloadFile", 413, `file larger than ${maxBytes} bytes`);
		return buffer;
	}

	/**
	 * The menu the user sees when they type "/" is per scope, and a more specific scope wins. Register
	 * both so another program sharing this token cannot leave its own command list in front of ours.
	 */
	setMyCommands(commands: { command: string; description: string }[], scope?: BotCommandScope): Promise<void> {
		return this.api<void>("setMyCommands", scope ? { commands, scope } : { commands });
	}

	/** What telegram actually serves for a scope — the only way to know if the menu was overwritten. */
	getMyCommands(scope?: BotCommandScope): Promise<BotCommand[]> {
		return this.api<BotCommand[]>("getMyCommands", scope ? { scope } : {});
	}

	answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
		return this.api<void>("answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			...(text ? { text } : {}),
			show_alert: showAlert,
		}).catch(() => undefined);
	}
}

export interface BotCommand {
	command: string;
	description: string;
}

export interface BotCommandScope {
	type: "all_private_chats" | "all_group_chats" | "all_chat_admins" | "default" | "chat" | "chat_administrators";
	chat_id?: number;
}

export function stripHtml(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

/** Copy into a buffer DOM Blob accepts without SharedArrayBuffer complaints. */
function toBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(data);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
