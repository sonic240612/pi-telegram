/**
 * The bridge has a voice of its own — menus, keyboards, notices about compaction, failures, pairing.
 * pi's answers arrive in whatever language the model answers in, so only this voice needs a language,
 * and it is chosen per chat: an explicit choice for that chat, then the configured default, then the
 * language Telegram says the user's client speaks.
 *
 * Two kinds of help are used at call sites:
 *   L(ko, en)         a message to render for the chat it is going to (the bridge renders it on send)
 *   pick(lang, …)     a label that must be right before the message is built — keyboard buttons
 */

export type Lang = "ko" | "en";

export const LANGS: readonly Lang[] = ["ko", "en"];

/** Something the bridge can say, either already in one language or in both. */
export type Localized = string | ((lang: Lang) => string);

/** The two ways of saying one thing. Kept side by side so a translation cannot drift from the code. */
export function L(ko: string, en: string): (lang: Lang) => string {
	return (lang) => (lang === "ko" ? ko : en);
}

/** One of two strings, for the places that must decide early (button labels, draft headers). */
export function pick(lang: Lang, ko: string, en: string): string {
	return lang === "ko" ? ko : en;
}

export function render(text: Localized, lang: Lang): string {
	return typeof text === "string" ? text : text(lang);
}

/**
 * Telegram sends the language of the user's client on every update ("ko", "en-US", "ja"…). Anything we
 * have no words for is English, because English is the language this project's documentation assumes.
 */
export function langFromTelegramCode(code: string | undefined): Lang | undefined {
	const base = code?.split(/[-_]/)[0]?.toLowerCase();
	if (!base) return undefined;
	if (base === "ko") return "ko";
	return LANGS.includes(base as Lang) ? (base as Lang) : "en";
}

export function isLang(value: unknown): value is Lang {
	return value === "ko" || value === "en";
}
