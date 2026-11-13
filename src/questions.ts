/**
 * Questionnaires that *other* extensions ask the user.
 *
 * `@juicesharp/rpiv-ask-user-question` registers `ask_user_question`, publishes the open
 * questionnaire on pi's extension event bus, and renders it in the terminal. A phone user is then
 * left out of the loop: the run sits waiting for a keystroke nobody can make remotely.
 *
 * This module mirrors that questionnaire into the chats as buttons and posts the answer back on the
 * same bus channel the package documents for hosts (`rpiv:ask-user:answer`). Nothing is patched and
 * no internals are touched, so the terminal can answer too — whoever answers first wins, which is
 * exactly how that package behaves for its own host integrations.
 *
 * Every payload coming off the bus belongs to someone else, so every field is treated as unknown
 * and capped: a malformed or hostile questionnaire must never crash the bridge or flood a chat.
 */
import type { CallbackAction, CallbackActionKind, CallbackEntry, CallbackResult, Hub } from "./hub.ts";
import { escapeHtml, inlineCode, tgDebug, truncate } from "./format.ts";
import type { TgInlineKeyboardButton } from "./telegram.ts";

/** Channels rpiv-ask-user-question documents as stable and JSON-safe. */
export const ASK_PROMPT_EVENT = "rpiv:ask-user:prompt";
export const ASK_BLOCKED_EVENT = "rpiv:ask-user:blocked";
export const ASK_ANSWER_EVENT = "rpiv:ask-user:answer";
export const ASK_ANSWER_RESULT_EVENT = "rpiv:ask-user:answer-result";

/** pi's own bus surface, narrowed to what this module needs (and easy to fake in tests). */
export interface EventBusLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export const ASKQ_KINDS: CallbackActionKind[] = ["askq:option", "askq:multi", "askq:text", "askq:submit", "askq:cancel"];

/** Hard caps: the contract says 1-4 questions, but we are not the ones writing this payload. */
const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 12;
const MAX_QUESTION_TEXT = 600;
const MAX_OPTION_TEXT = 120;
const MAX_DESCRIPTION_TEXT = 160;
/** How long a chat has to type the answer after pressing ✏️. */
const TEXT_WINDOW_MS = 5 * 60 * 1000;
/** Keyboard labels are clipped by telegram at 64; leave room for the check mark. */
const BUTTON_LABEL = 52;

interface QuestionChoice {
	label: string;
	description?: string;
	hasPreview: boolean;
}

interface Question {
	text: string;
	header?: string;
	multi: boolean;
	choices: QuestionChoice[];
}

interface AnswerState {
	indexes: number[];
	text?: string;
}

interface Rendered {
	chatId: number;
	messageId?: number;
}

interface Questionnaire {
	toolCallId: string;
	requestId?: string;
	questions: Question[];
	answers: (AnswerState | undefined)[];
	rendered: Rendered[];
	/** chatId -> question waiting for a typed answer */
	awaitingText: Map<number, { index: number; expiresAt: number }>;
	closed: boolean;
	at: number;
}

/**
 * Buttons are only useful while the questionnaire is open, so all state lives here and the bridge
 * just routes `askq:*` taps and typed answers back in.
 */
export class QuestionnaireBridge {
	private readonly hub: Hub;
	private bus: EventBusLike | undefined;
	private open = new Map<string, Questionnaire>();
	/** Tokens handed out, so answering in one chat closes the keyboards in the others. */
	private tokens = new Map<string, string>(); // token -> toolCallId
	private textTimers = new Map<number, ReturnType<typeof setTimeout>>();

	constructor(hub: Hub) {
		this.hub = hub;
	}

	register(bus: EventBusLike): void {
		this.bus = bus;
		bus.on(ASK_PROMPT_EVENT, (data) => void this.onPrompt(data));
		bus.on(ASK_BLOCKED_EVENT, (data) => void this.onBlocked(data));
		bus.on(ASK_ANSWER_RESULT_EVENT, (data) => this.onAnswerResult(data));
	}

	/** Questionnaires currently waiting on this bridge (used to silence generic dialog notices). */
	openCount(): number {
		return this.open.size;
	}

	closeAll(reason: string): void {
		for (const [toolCallId] of [...this.open]) this.close(toolCallId, reason);
	}

	/** A revoked chat loses its keyboards and any typed answer it was about to send. */
	dropChat(chatId: number): void {
		for (const q of this.open.values()) {
			q.rendered = q.rendered.filter((entry) => entry.chatId !== chatId);
			q.awaitingText.delete(chatId);
		}
	}

	/**
	 * A plain chat message is the answer while a chat sits in ✏️ mode. Commands still go to pi, and
	 * anything else must not be swallowed after the window closes.
	 */
	async consumeText(chatId: number, text: string): Promise<boolean> {
		const question = this.openFor(chatId);
		if (!question) return false;
		const waiting = question.awaitingText.get(chatId);
		if (!waiting) return false;
		question.awaitingText.delete(chatId);
		this.clearTextTimer(chatId);
		// A multi-select question keeps its checked options and gains the typed answer, exactly like the
		// terminal's `Type something.` row; a single-select one takes the text instead of the pick.
		const prior = question.answers[waiting.index];
		const keep = question.questions[waiting.index].multi ? (prior?.indexes ?? []) : [];
		question.answers[waiting.index] = { indexes: keep, text: text.slice(0, MAX_QUESTION_TEXT * 2) };
		this.dbg("typed answer", question.toolCallId, waiting.index, text.slice(0, 40));
		if (question.questions.length === 1) {
			await this.submit(question, chatId);
			return true;
		}
		await this.rerender(question);
		await this.hub.send(chatId, `✏️ <i>${waiting.index + 1}번 답변을 적어 두었어요. 나머지 질문에 답한 뒤 ✅ 제출 버튼으로 보내 주세요.</i>`, { markdown: false });
		return true;
	}

	async handleCallback(chatId: number, messageId: number | undefined, entry: CallbackEntry): Promise<CallbackResult> {
		const action = entry.action;
		const toolCallId = typeof action.blob === "object" && action.blob !== null ? (action.blob as { toolCallId?: string }).toolCallId : undefined;
		const question = toolCallId ? this.open.get(toolCallId) : undefined;
		if (!question) return { toast: "그 질문은 이미 끝났어요", showAlert: true };
		const blob = action.blob as { index?: number; option?: number };
		const index = blob?.index ?? -1;
		const option = blob?.option;

		switch (action.kind) {
			case "askq:cancel":
				await this.submit(question, chatId, true);
				return { toast: "거절했어요" };
			case "askq:submit":
				if (!this.answeredAll(question)) {
					const missing = question.answers.map((answer, i) => (answer ? null : i + 1)).filter(Boolean);
					return { toast: `아직 안 고른 질문: ${missing.join(", ")}`, showAlert: true };
				}
				await this.submit(question, chatId);
				return { toast: "보냈어요" };
			case "askq:text": {
				question.awaitingText.set(chatId, { index, expiresAt: Date.now() + TEXT_WINDOW_MS });
				this.startTextTimer(chatId, question);
				await this.rerender(question);
				return { toast: "이제 채팅에 답을 적어 보내세요", keep: true };
			}
			case "askq:multi": {
				if (option === undefined) return { toast: "항목을 찾을 수 없어요", showAlert: true };
				const current = question.answers[index] ?? { indexes: [] };
				current.indexes = current.indexes.includes(option) ? current.indexes.filter((i) => i !== option) : [...current.indexes, option];
				delete current.text;
				question.answers[index] = current;
				await this.rerender(question);
				return { toast: current.indexes.includes(option) ? "선택했어요" : "해제했어요", keep: true };
			}
			case "askq:option": {
				if (option === undefined) return { toast: "항목을 찾을 수 없어요", showAlert: true };
				if (question.questions.length === 1 && !question.questions[0].multi) {
					question.answers[0] = { indexes: [option] };
					await this.submit(question, chatId);
					return { toast: question.questions[0].choices[option]?.label?.slice(0, 48) ?? "선택했어요" };
				}
				question.answers[index] = { indexes: [option] };
				await this.rerender(question);
				return { toast: "선택했어요 — 제출 버튼으로 마무리", keep: true };
			}
			default:
				return { toast: "" };
		}
	}

	// ------------------------------------------------------------------ payload

	private async onPrompt(data: unknown): Promise<void> {
		const payload = asRecord(data);
		const toolCallId = stringOr(payload?.toolCallId);
		const rawQuestions = Array.isArray(payload?.questions) ? payload?.questions : [];
		if (!toolCallId) {
			this.hub.notify("telegram: ignored an ask-user-question event with no toolCallId", "warning");
			return;
		}
		const questions = rawQuestions.slice(0, MAX_QUESTIONS).map(normalizeQuestion).filter((q): q is Question => Boolean(q));
		if (!questions.length) {
			this.hub.notify(`telegram: ask-user-question ${toolCallId} carried no usable questions`, "warning");
			return;
		}
		const requestId = stringOr(payload?.requestId);
		const existing = this.open.get(toolCallId);
		if (existing) {
			// A re-published questionnaire (redrawn dialog) keeps the answers gathered so far.
			existing.questions = questions;
			existing.requestId = requestId ?? existing.requestId;
			await this.rerender(existing);
			return;
		}
		const question: Questionnaire = {
			toolCallId,
			...(requestId ? { requestId } : {}),
			questions,
			answers: questions.map(() => undefined),
			rendered: [],
			awaitingText: new Map(),
			closed: false,
			at: Date.now(),
		};
		this.open.set(toolCallId, question);
		this.dbg("questionnaire open", toolCallId, questions.length);
		// Render into every paired chat: the phone that answers is the phone that is watching.
		for (const chatId of this.hub.chats()) {
			const { html, rows } = this.render(question, chatId);
			try {
				const sentId = await this.hub.send(chatId, html, { markdown: false, keyboard: rows });
				question.rendered.push({ chatId, ...(sentId !== undefined ? { messageId: sentId } : {}) });
			} catch (error) {
				this.hub.notify(`telegram: could not show a question in chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		if (!question.rendered.length) {
			this.open.delete(toolCallId);
			return;
		}
		this.hub.notify(`telegram: pi는 선택을 기다려요 (ask_user_question · ${questions.length} question(s)) — 답은 pi 터미널에서도 가능`, "info");
	}

	private async onBlocked(data: unknown): Promise<void> {
		const payload = asRecord(data);
		if (!payload || payload.active !== false) return;
		const toolCallId = stringOr(payload.toolCallId);
		if (toolCallId) this.close(toolCallId, "질문이 닫혔어요 (pi 터미널에서 답했거나 취소됐어요).");
		else this.closeAll("질문이 닫혔어요 (pi 터미널에서 답했거나 취소됐어요).");
	}

	private onAnswerResult(data: unknown): void {
		const payload = asRecord(data);
		if (!payload || payload.ok !== false) return;
		const code = stringOr(payload.code) ?? "unknown";
		const toolCallId = stringOr(payload.toolCallId);
		const toolCallIdOk = toolCallId ? this.open.has(toolCallId) : true;
		const note = RESULT_TEXT[code] ?? `답변이 접수되지 않았어요 (${code}).`;
		this.hub.notify(`telegram: ask_user_question rejected an answer — ${code}`, "warning");
		this.dbg("answer rejected", code, toolCallId);
		if (code === "not_found" && toolCallId && !toolCallIdOk) return; // already closed locally, no need to shout
		for (const chatId of this.hub.chats()) {
			void this.hub.send(chatId, `⚠️ <i>${escapeHtml(note)}</i>`, { markdown: false }).catch(() => undefined);
		}
	}

	// --------------------------------------------------------------------- state

	private openFor(chatId: number): Questionnaire | undefined {
		for (const question of this.open.values()) if (question.awaitingText.has(chatId)) return question;
		return undefined;
	}

	private answeredAll(question: Questionnaire): boolean {
		return question.answers.every((answer) => answer && (answer.indexes.length > 0 || (answer.text ?? "").trim().length > 0));
	}

	private buildAnswers(question: Questionnaire) {
		// Validation on the other side is strict and all-or-nothing, so a question answered by buttons
		// must not carry a blank text and a typed one must not carry an empty index list.
		return question.answers.map((answer, index) => ({
			questionIndex: index,
			...(answer?.indexes.length ? { optionIndexes: answer.indexes } : {}),
			...(answer?.text !== undefined && answer.text.trim() ? { text: answer.text } : {}),
		}));
	}

	private async submit(question: Questionnaire, chatId: number, cancel = false): Promise<void> {
		const bus = this.bus;
		if (!bus) return;
		const payload = {
			toolCallId: question.toolCallId,
			...(question.requestId ? { requestId: question.requestId } : {}),
			answers: cancel ? [] : this.buildAnswers(question),
			...(cancel ? { cancel: true } : {}),
		};
		this.close(question.toolCallId, cancel ? "거절했어요 — pi 터미널에서도 같은 질문이 닫혀요." : "✅ 답변을 pi에 전달했어요.");
		try {
			bus.emit(ASK_ANSWER_EVENT, payload);
			this.hub.notify(
				`telegram: answered ask_user_question from chat ${chatId} — ${cancel ? "cancelled" : `${payload.answers.length} answer(s)`}`,
				"info",
			);
		} catch (error) {
			this.hub.notify(`telegram: could not deliver the answer: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	private close(toolCallId: string, note: string): void {
		const question = this.open.get(toolCallId);
		if (!question) return;
		this.open.delete(toolCallId);
		question.closed = true;
		for (const [token, owner] of this.tokens) if (owner === toolCallId) {
			this.hub.dropToken(token);
			this.tokens.delete(token);
		}
		for (const [, timer] of this.textTimers) clearTimeout(timer);
		this.textTimers.clear();
		for (const { chatId, messageId } of question.rendered) {
			if (messageId === undefined) continue;
			void this.hub
				.editKeyboard(chatId, messageId, `${questionHeadline(question)}\n\n<i>${escapeHtml(note)}</i>`, [])
				.catch(() => undefined);
		}
		this.dbg("questionnaire closed", toolCallId, note.slice(0, 30));
	}

	private dropTokens(toolCallId: string): void {
		for (const [token, owner] of this.tokens) if (owner === toolCallId) {
			this.hub.dropToken(token);
			this.tokens.delete(token);
		}
	}

	/** Repaint every chat that can see this questionnaire, so the check marks agree everywhere. */
	private async rerender(question: Questionnaire): Promise<void> {
		if (question.closed) return;
		this.dropTokens(question.toolCallId);
		for (const rendered of question.rendered) {
			if (rendered.messageId === undefined) continue;
			const { html, rows } = this.render(question, rendered.chatId);
			try {
				await this.hub.editKeyboard(rendered.chatId, rendered.messageId, html, rows);
			} catch {
				/* edited away (session replaced, message too old): the buttons expire on tap instead */
			}
		}
	}

	// ------------------------------------------------------------------ rendering

	private render(question: Questionnaire, chatId: number): { html: string; rows: TgInlineKeyboardButton[][] } {
		const parts: string[] = [questionHeadline(question)];
		const rows: TgInlineKeyboardButton[][] = [];
		question.questions.forEach((item, index) => {
			const answer = question.answers[index];
			const label = question.questions.length > 1 ? `<b>${index + 1}. ${escapeHtml(truncate(item.text, MAX_QUESTION_TEXT))}</b>` : `<b>${escapeHtml(truncate(item.text, MAX_QUESTION_TEXT))}</b>`;
			const meta = [item.header ? escapeHtml(item.header) : undefined, item.multi ? "여러 개 선택" : "하나 선택"].filter(Boolean).join(" · ");
			parts.push(`${label}${meta ? `\n<i>${meta}</i>` : ""}`);
			if (item.choices.length) {
				parts.push(
					item.choices
						.map((choice, optionIndex) => {
							const chosen = answer?.indexes.includes(optionIndex);
							const description = choice.description ? ` — <i>${escapeHtml(truncate(choice.description, MAX_DESCRIPTION_TEXT))}</i>` : "";
							return `${chosen ? "✅" : "▫️"} <b>${escapeHtml(truncate(choice.label, MAX_OPTION_TEXT))}</b>${description}${choice.hasPreview ? " <i>(미리보기 있음)</i>" : ""}`;
						})
						.join("\n"),
				);
			}
			if (answer?.text) parts.push(`✏️ 답: ${inlineCode(truncate(answer.text, MAX_OPTION_TEXT))}`);
			// Option buttons first, then the typed-answer escape hatch the package always offers.
			for (let start = 0; start < item.choices.length; start += 2) {
				rows.push(
					item.choices.slice(start, start + 2).map((choice, offset) => {
						const optionIndex = start + offset;
						const chosen = answer?.indexes.includes(optionIndex);
						const kind: CallbackActionKind = item.multi ? "askq:multi" : "askq:option";
						const token = this.hub.createToken(
							{ kind, blob: { toolCallId: question.toolCallId, index, option: optionIndex } } satisfies CallbackAction,
							chatId,
						);
						this.tokens.set(token, question.toolCallId);
						return { text: `${chosen ? "✓ " : ""}${truncate(choice.label, BUTTON_LABEL)}`, callback_data: token };
					}),
				);
			}
			const textToken = this.hub.createToken({ kind: "askq:text", blob: { toolCallId: question.toolCallId, index } }, chatId);
			this.tokens.set(textToken, question.toolCallId);
			const waiting = question.awaitingText.get(chatId)?.index === index;
			rows.push([{ text: waiting ? "✏️ 지금 답 입력 중…" : `✏️ 직접 입력${question.questions.length > 1 ? ` (${index + 1})` : ""}`, callback_data: textToken }]);
		});
		const nav: TgInlineKeyboardButton[] = [];
		const needsSubmit = question.questions.length > 1 || question.questions.some((item) => item.multi);
		if (needsSubmit) {
			const token = this.hub.createToken({ kind: "askq:submit", blob: { toolCallId: question.toolCallId } }, chatId);
			this.tokens.set(token, question.toolCallId);
			nav.push({ text: "✅ 제출", callback_data: token });
		}
		const cancelToken = this.hub.createToken({ kind: "askq:cancel", blob: { toolCallId: question.toolCallId } }, chatId);
		this.tokens.set(cancelToken, question.toolCallId);
		nav.push({ text: "✖️ 거절", callback_data: cancelToken });
		rows.push(nav);
		return { html: parts.join("\n\n"), rows };
	}

	private startTextTimer(chatId: number, question: Questionnaire): void {
		this.clearTextTimer(chatId);
		const timer = setTimeout(() => {
			this.textTimers.delete(chatId);
			const waiting = question.awaitingText.get(chatId);
			if (!waiting || !this.open.has(question.toolCallId)) return;
			question.awaitingText.delete(chatId);
			void this.rerender(question);
			void this.hub.send(chatId, `⌛ <i>직접 입력 창이 만료됐어요. 다시 ✏️ 버튼을 누르거나 pi에 그냥 보내세요.</i>`, { markdown: false }).catch(() => undefined);
		}, TEXT_WINDOW_MS);
		timer.unref?.();
		this.textTimers.set(chatId, timer);
	}

	private clearTextTimer(chatId: number): void {
		const timer = this.textTimers.get(chatId);
		if (timer) clearTimeout(timer);
		this.textTimers.delete(chatId);
	}

	private dbg(...parts: unknown[]): void {
		tgDebug("questions", ...parts);
	}
}

function questionHeadline(question: Questionnaire): string {
	return `❓ <b>pi가 선택을 기다려요</b> <i>(ask_user_question · ${question.questions.length}개 질문)</i>`;
}

function normalizeQuestion(raw: unknown): Question | undefined {
	const record = asRecord(raw);
	// The published payload says `question`; `text` is accepted for tolerance.
	const text = stringOr(record?.question) ?? stringOr(record?.text);
	if (!text) return undefined;
	const choices = (Array.isArray(record?.options) ? record.options : []).slice(0, MAX_OPTIONS).map(normalizeChoice).filter((c): c is QuestionChoice => Boolean(c));
	return {
		text,
		...(stringOr(record?.header) ? { header: stringOr(record?.header) as string } : {}),
		multi: record?.multiSelect === true,
		choices,
	};
}

function normalizeChoice(raw: unknown): QuestionChoice | undefined {
	const record = asRecord(raw);
	const label = stringOr(record?.label) ?? stringOr(record);
	if (!label) return undefined;
	const description = stringOr(record?.description);
	// `hasPreview` is the published flag; the preview body itself never crosses the bus.
	const hasPreview = record?.hasPreview === true || typeof record?.preview === "string";
	return {
		label,
		...(description ? { description } : {}),
		hasPreview,
	};
}

const RESULT_TEXT: Record<string, string> = {
	not_found: "그 질문은 이미 끝났어요 — pi 터미널에서 먼저 답했을 수 있어요.",
	invalid_payload: "답변 형식이 pi가 기대한 것과 달라서 거부됐어요.",
	invalid_answer: "답변이 질문과 맞지 않아요 — 항목을 다시 골라 주세요.",
	unsupported_host: "이 pi는 원격 답변을 받지 않는 실행 방식이에요 — pi 터미널에서 답해야 해요.",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
