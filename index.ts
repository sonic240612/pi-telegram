/**
 * pi-telegram — talk to a running pi agent from Telegram.
 *
 * Pi keeps owning the session: this extension mirrors what the terminal shows,
 * turns Telegram text/files into pi prompts, and re-implements the useful pi
 * slash commands (/model, /thinking, /compact, /new, /resume, /fork, /tree, …)
 * as chat messages with inline keyboards.
 *
 * Setup:
 *   1. create a bot with @BotFather
 *   2. in pi: /telegram-setup <bot-token>      (or TELEGRAM_BOT_TOKEN / ~/.pi/agent/telegram.json)
 *   3. message the bot anything, then in pi: /telegram-pair  →  /telegram-pair <code>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelegramBridge } from "./src/bridge.ts";
import { tgDebug } from "./src/format.ts";

export default function piTelegram(pi: ExtensionAPI): void {
	const bridge = new TelegramBridge(pi);
	// pi re-creates extensions when a session is replaced, so installs are logged with an instance id.
	tgDebug(`extension installed as bridge#${bridge.instanceId}`);

	pi.registerFlag("telegram-token", { type: "string", description: "Telegram bot token used by pi-telegram" });
	pi.registerFlag("telegram-off", { type: "boolean", description: "Load pi-telegram but do not connect to Telegram" });

	bridge.install();

	const flagToken = pi.getFlag("telegram-token");
	if (typeof flagToken === "string" && flagToken.trim()) bridge.setToken(flagToken.trim());
	if (pi.getFlag("telegram-off") === true) bridge.disable();
}
