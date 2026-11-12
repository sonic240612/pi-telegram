/**
 * Streaming draft messages: pi's terminal updates in place, so Telegram does too.
 *
 * Telegram allows roughly one edit per chat every couple of seconds, so edits are throttled with a
 * trailing timer that always applies the newest text.
 *
 * A draft becomes chat history once it carries delivered content: `sealed` drafts are never edited
 * again and never deleted, so the answer you already read stays in the chat when the next turn
 * starts. Only a draft that still shows nothing but a placeholder ("⏳ 생각 중…") may be deleted.
 */
import type { TelegramBot } from "./telegram.ts";

export interface DraftState {
	messageId: number;
	text: string;
	lastEditAt: number;
	pendingText?: string;
	timer?: ReturnType<typeof setTimeout>;
	chain: Promise<void>;
	/** Retired: the next update opens a new message instead of editing this one. */
	sealed: boolean;
	/** The message has shown real transcript text, so it must survive as history. */
	hasContent: boolean;
}

const MIN_EDIT_INTERVAL_MS = 1800;

/** Placeholder notices ("⏳ 생각 중…") are disposable; anything else is content worth keeping. */
function isPlaceholder(text: string): boolean {
	const flat = text.replace(/<[^>]*>/g, "").trim();
	return flat === "" || /^(⏳|🤔|…|\.\.\.)/.test(flat);
}

export class DraftManager {
	private drafts = new Map<number, DraftState>();

	readonly bot: () => TelegramBot | undefined;
	readonly editIntervalMs: number;

	constructor(bot: () => TelegramBot | undefined, editIntervalMs = MIN_EDIT_INTERVAL_MS) {
		this.bot = bot;
		this.editIntervalMs = editIntervalMs;
	}

	/** Show `text` as the live draft for `chatId`. Cheap to call on every token. */
	async update(chatId: number, text: string): Promise<void> {
		const bot = this.bot();
		if (!bot || !text.trim()) return;
		const draft = this.drafts.get(chatId);
		if (!draft || draft.sealed) {
			try {
				const message = await bot.sendSafe(chatId, text);
				if (!message) return;
				this.drafts.set(chatId, {
					messageId: message.message_id,
					text,
					lastEditAt: Date.now(),
					chain: Promise.resolve(),
					sealed: false,
					hasContent: !isPlaceholder(text),
				});
			} catch {
				/* the draft is a nicety; the final message still arrives */
			}
			return;
		}
		if (text === draft.text) return;
		const sinceEdit = Date.now() - draft.lastEditAt;
		if (sinceEdit >= this.editIntervalMs) {
			this.applyNow(chatId, draft, text);
			return;
		}
		draft.pendingText = text;
		if (draft.timer) return;
		const timer = setTimeout(() => {
			const current = this.drafts.get(chatId);
			if (!current) return;
			current.timer = undefined;
			const pending = current.pendingText;
			current.pendingText = undefined;
			if (pending) this.applyNow(chatId, current, pending);
		}, this.editIntervalMs - sinceEdit);
		timer.unref?.();
		draft.timer = timer;
	}

	private applyNow(chatId: number, draft: DraftState, text: string): void {
		const bot = this.bot();
		if (!bot) return;
		draft.lastEditAt = Date.now();
		draft.text = text;
		if (!isPlaceholder(text)) draft.hasContent = true;
		draft.chain = draft.chain.then(async () => {
			const ok = await bot.editSafe(chatId, draft.messageId, text);
			if (!ok) this.drafts.delete(chatId);
		});
	}

	/** Finalize the draft with the complete text and retire it as history. Returns the message id. */
	async finalize(chatId: number, text: string): Promise<number | undefined> {
		const draft = this.drafts.get(chatId);
		if (!draft || draft.sealed) return undefined; // caller sends the answer as regular message(s)
		if (draft.timer) clearTimeout(draft.timer);
		draft.timer = undefined;
		draft.sealed = true;
		if (!isPlaceholder(text)) draft.hasContent = true;
		this.applyNow(chatId, draft, text);
		await draft.chain.catch(() => undefined);
		return draft.messageId;
	}

	/**
	 * Retire the current draft. The message is deleted only while it still holds nothing but a
	 * placeholder — an answer the user has already read stays in the chat as history.
	 */
	async discard(chatId: number): Promise<void> {
		const draft = this.drafts.get(chatId);
		if (!draft) return;
		if (draft.timer) clearTimeout(draft.timer);
		draft.timer = undefined;
		draft.pendingText = undefined;
		draft.sealed = true;
		if (draft.hasContent) return; // keep it: it is part of the conversation now
		await this.forget(chatId, draft.messageId);
	}

	/** Stop tracking a draft without touching the message on Telegram. */
	release(chatId: number): void {
		const draft = this.drafts.get(chatId);
		if (draft?.timer) clearTimeout(draft.timer);
		this.drafts.delete(chatId);
	}

	private async forget(chatId: number, messageId: number): Promise<void> {
		this.drafts.delete(chatId);
		const bot = this.bot();
		if (bot) await bot.deleteMessage(chatId, messageId).catch(() => undefined);
	}

	releaseAll(): void {
		for (const chatId of [...this.drafts.keys()]) this.release(chatId);
	}

	/** Forget every draft without deleting anything — used when the bridge goes down. */
	dropAll(): void {
		for (const draft of this.drafts.values()) {
			if (draft.timer) clearTimeout(draft.timer);
		}
		this.drafts.clear();
	}

	activeMessageId(chatId: number): number | undefined {
		const draft = this.drafts.get(chatId);
		return draft && !draft.sealed ? draft.messageId : undefined;
	}
}
