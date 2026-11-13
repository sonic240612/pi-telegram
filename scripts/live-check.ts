/**
 * Live check against the real pi process (no Telegram account needed).
 *
 * Starts pi in RPC mode with this extension loaded, points the bridge at a local mock Telegram
 * Bot API, then drives every Telegram command through that mock and inspects the replies and pi's
 * stderr. This is the check that catches real pi API shapes (the fake pi in smoke.ts cannot).
 *
 *   node scripts/live-check.ts        (or: npm run live)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAT = 555000111;
const TOKEN = "123456:LOCAL-CHECK-TOKEN-not-a-real-bot";

const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-live-agent-"));
// PI_TG_LIVE_SRC: copy a real agent dir (auth/models/settings) so the check runs against the
// same model catalog, installed extensions and sessions the user sees. Nothing is sent anywhere:
// Telegram is still the local mock, and PI_OFFLINE=1 keeps pi from fetching catalogs.
const copySessions = process.env.PI_TG_LIVE_SESSIONS === "1";
const mask = process.env.PI_TG_LIVE_MASK === "1";
const srcAgent = process.env.PI_TG_LIVE_SRC;
if (srcAgent) {
	for (const file of ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"]) {
		const from = join(srcAgent, file);
		if (existsSync(from)) copyFileSync(from, join(agentDir, file));
	}
	if (copySessions && existsSync(join(srcAgent, "sessions"))) {
		for (const bucket of readdirSync(join(srcAgent, "sessions"))) {
			const srcBucket = join(srcAgent, "sessions", bucket);
			if (!statSync(srcBucket).isDirectory()) continue;
			mkdirSync(join(agentDir, "sessions", bucket), { recursive: true });
			for (const file of readdirSync(srcBucket).filter((name) => name.endsWith(".jsonl")).slice(0, 12)) {
				copyFileSync(join(srcBucket, file), join(agentDir, "sessions", bucket, file));
			}
		}
	}
}
const workDir = mkdtempSync(join(tmpdir(), "pi-tg-live-work-"));
writeFileSync(
	join(agentDir, "telegram.json"),
	JSON.stringify({ token: TOKEN, chats: [{ chatId: CHAT, label: "live check" }], verbosity: 2, streaming: true, announce: false }),
	"utf8",
);

// ── mock Telegram Bot API ─────────────────────────────────────────────────────────
interface Call {
	method: string;
	params: Record<string, unknown>;
}
const calls: Call[] = [];
let updates: Record<string, unknown>[] = [];
let updateId = 0;
let msgId = 0;
const menuScopes = new Map<string, string[]>();

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const method = url.pathname.split("/").pop() ?? "";
	if (req.method === "GET" && url.pathname.startsWith("/file/")) {
		// bytes the bridge downloads for photos/documents
		res.writeHead(200, { "content-type": "image/jpeg" });
		res.end(Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/9s=", "base64"));
		return;
	}
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		let params: Record<string, unknown> = {};
		try {
			params = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		} catch {
			/* not json */
		}
		calls.push({ method, params });
		const json = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, result }));
		};
		switch (method) {
			case "getMe":
				return json({ id: 77, is_bot: true, first_name: "PiBridge", username: "pi_bridge_local_check_bot" });
			case "getUpdates": {
				const drained = updates;
				updates = [];
				return json(drained);
			}
			case "sendMessage":
				return json({ message_id: ++msgId, chat: { id: Number(params.chat_id ?? 0), type: "private" }, date: 0, text: params.text });
			case "editMessageText":
				return json({ message_id: Number(params.message_id ?? ++msgId), chat: { id: Number(params.chat_id ?? 0), type: "private" }, date: 0, text: params.text });
			case "getFile":
				return json({ file_id: String(params.file_id ?? "f"), file_unique_id: "u", file_size: 1200, file_path: `file/bot77/sample-${String(params.file_id ?? "f")}.jpg` });
			case "setMyCommands": {
				const scope = String((params.scope as { type?: string } | undefined)?.type ?? "default");
				menuScopes.set(scope, (params.commands as { command?: string }[] ?? []).map((entry) => String(entry?.command ?? "")).filter(Boolean));
				return json(true);
			}
			case "getMyCommands": {
				const scope = String((params.scope as { type?: string } | undefined)?.type ?? "default");
				return json([...(menuScopes.get(scope) ?? [])].map((command) => ({ command, description: "" })));
			}
			default:
				return json(true);
		}
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiRoot = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

function send(chatId: number, text: string): void {
	updates.push({
		update_id: ++updateId,
		message: { message_id: ++msgId, from: { id: 900, first_name: "Live" }, chat: { id: chatId, type: "private", first_name: "Live" }, date: 0, text },
	});
}
function tap(messageId: number, data: string): void {
	updates.push({
		update_id: ++updateId,
		callback_query: { id: `q${updateId}`, from: { id: 900, first_name: "Live" }, message: { message_id: messageId, chat: { id: CHAT, type: "private" }, date: 0 }, data },
	});
}
function sendPhoto(chatId: number, fileId: string, caption: string): void {
	updates.push({
		update_id: ++updateId,
		message: {
			message_id: ++msgId,
			from: { id: 900, first_name: "Live" },
			chat: { id: chatId, type: "private", first_name: "Live" },
			date: 0,
			caption,
			photo: [{ file_id: fileId, file_size: 1200, width: 64, height: 64 }, { file_id: `${fileId}-big`, file_size: 4800, width: 512, height: 512 }],
		},
	});
}
function sendVoice(chatId: number): void {
	updates.push({
		update_id: ++updateId,
		message: {
			message_id: ++msgId,
			from: { id: 900, first_name: "Live" },
			chat: { id: chatId, type: "private", first_name: "Live" },
			date: 0,
			voice: { file_id: "voice-1", file_size: 900, mime_type: "audio/ogg", duration: 3 },
		},
	});
}
function scrub(text: string): string {
	// Mask mode keeps real session titles / prompts out of the console output.
	return mask ? `<${text.length} chars>` : text;
}
/** Structure without content: keeps emoji and punctuation, hides words (for debugging masked runs). */
function shape(text: string): string {
	return mask ? text.replace(/\p{L}+/gu, "··").replace(/\s+/g, " ").slice(0, 200) : text.slice(0, 200);
}
function replies(): string[] {
	return calls
		.filter((call) => call.method === "sendMessage" || call.method === "editMessageText")
		.map((call) => String(call.params.text ?? "").replace(/\s+/g, " ").trim())
		.filter((text) => text.length > 0);
}
function lastKeyboardInfo(needle: string): { buttons: { text: string; callback_data: string }[]; messageId: number } {
	const withKeyboard = calls.filter((call) => call.method === "sendMessage" && String(call.params.text ?? "").includes(needle) && call.params.reply_markup);
	const last = withKeyboard.at(-1);
	const rows = (last?.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
	return { buttons: rows.flat(), messageId: Number(last?.params.message_id ?? 0) };
}
/** Header text of the newest keyboarded message matching `needle` — it carries counts and hints. */
function lastKeyboardText(needle: string): string {
	const withKeyboard = calls.filter((call) => call.method === "sendMessage" && String(call.params.text ?? "").includes(needle) && call.params.reply_markup);
	return String(withKeyboard.at(-1)?.params.text ?? "");
}

// ── real pi in RPC mode ───────────────────────────────────────────────────────────
const piPackageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const piCli = join(piPackageDir, "dist", "bundle", "cli.js");

const extraArgs = process.env.PI_TG_LIVE_EXT === "1" ? [] : ["--no-extensions"];
/**
 * PI_TG_LIVE_PKGS="pi-goal-x,rpiv": load the user's *installed* extensions next to ours, so the
 * interop checks run against the real packages rather than against fixtures that imitate them.
 * Ours is always skipped — the check already loads it with `-e`, and two bridges on one mock API
 * would fight over the updates.
 */
const wantedPackages = (process.env.PI_TG_LIVE_PKGS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
if (srcAgent && wantedPackages.length) {
	try {
		const settings = JSON.parse(readFileSync(join(srcAgent, "settings.json"), "utf8")) as { packages?: string[] };
		for (const spec of settings.packages ?? []) {
			if (!wantedPackages.some((needle) => spec.includes(needle))) continue;
			if (spec.includes("pi-telegram")) continue;
			const dir = spec.startsWith("npm:")
				? join(srcAgent, "npm", "node_modules", spec.slice(4))
				: spec.startsWith("git:")
					? join(srcAgent, "git", spec.slice(4).replace(/:/g, "/"))
					: "";
			if (!dir || !existsSync(join(dir, "package.json"))) {
				console.log(`  --   PI_TG_LIVE_PKGS: cannot find an install for ${spec}`);
				continue;
			}
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { pi?: { extensions?: string[] }; exports?: Record<string, string> | string };
			const entries = (manifest.pi?.extensions ?? (typeof manifest.exports === "string" ? [manifest.exports] : Object.values(manifest.exports ?? {})))
				.map((rel) => join(dir, rel))
				.filter((path) => existsSync(path));
			if (!entries.length) {
				console.log(`  --   PI_TG_LIVE_PKGS: no extension entry found in ${spec}`);
				continue;
			}
			for (const entry of entries) extraArgs.push("-e", entry);
			console.log(`  --   loading installed package ${spec} (${entries.length} extension(s))`);
		}
	} catch (error) {
		console.log(`  --   PI_TG_LIVE_PKGS: could not read the package list: ${String(error)}`);
	}
}
const openSession = process.env.PI_TG_LIVE_OPEN_SESSION;
if (openSession && existsSync(openSession)) {
	const sessionDir = join(agentDir, "sessions", "live-check");
	mkdirSync(sessionDir, { recursive: true });
	const copied = join(sessionDir, `copied-${Date.now()}.jsonl`);
	copyFileSync(openSession, copied);
	extraArgs.push("--session", copied);
} else {
	extraArgs.push("--no-session");
}
const skipPrompt = Boolean(openSession);
const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--offline", ...extraArgs, "-e", join(process.cwd(), "index.ts")], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TELEGRAM_API_ROOT: apiRoot, PI_OFFLINE: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});

const stderrLines: string[] = [];
const stdoutLines: string[] = [];
const uiRequests: string[] = [];
let pendingStdout = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => stderrLines.push(...chunk.split(/\r?\n/)));

// A faithful RPC client answers pi's extension dialogs (select / confirm / input / editor);
// without these answers the extension's ctx.ui calls block forever and commands hang.
function answerDialog(request: { id?: string; method?: string; options?: string[]; title?: string }): void {
	if (!request.id || !request.method) return;
	const response: Record<string, unknown> = { type: "extension_ui_response", id: request.id };
	switch (request.method) {
		case "confirm":
			response.confirmed = true;
			break;
		case "select":
			response.value = request.options?.[0];
			break;
		case "input":
			response.value = "ok";
			break;
		case "editor":
			response.value = "";
			break;
		default:
			return;
	}
	uiRequests.push(`${request.method}:${scrub(request.title ?? "")}`);
	child.stdin.write(`${JSON.stringify(response)}\n`);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	pendingStdout += chunk;
	const parts = pendingStdout.split("\n");
	pendingStdout = parts.pop() ?? "";
	for (const line of parts.filter((entry) => entry.trim())) {
		stdoutLines.push(line);
		try {
			const record = JSON.parse(line) as { type?: string };
			if (record.type === "extension_ui_request") answerDialog(record as { id?: string; method?: string; options?: string[]; title?: string });
		} catch {
			/* not json */
		}
	}
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) return false;
		await sleep(25);
	}
	return true;
}

let failures = 0;
function check(description: string, ok: boolean, detail = ""): void {
	if (ok) console.log(`  ok   ${description}`);
	else {
		failures += 1;
		console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ""}`);
	}
}

async function command(line: string, timeoutMs = 15_000): Promise<void> {
	const before = replies().length;
	send(CHAT, line);
	const arrived = await waitFor(() => replies().length > before, timeoutMs);
	const reply = replies().slice(before).join(" | ");
	check(`reply for "${line}"`, arrived, scrub(reply).slice(0, 180));
}

console.log("pi-telegram live check (real pi process, mock Telegram API)");
console.log(`pi cli: ${piCli}`);

await waitFor(() => stdoutLines.length > 0, 30_000);
child.stdin.write(`${JSON.stringify({ id: "boot", type: "get_state" })}\n`);
const connected = await waitFor(() => calls.some((call) => call.method === "getMe"), 30_000);
check("extension loaded and bridge connected", connected, stderrLines.slice(-6).join(" | ").slice(0, 400));

await command("/start");
await command("/help");
await command("/ping");
await command("/status");
await command("/usage");
await command("/verbose 2");
await command("/model");
const modelKb = lastKeyboardInfo("model");
if (modelKb.buttons.length) {
	tap(modelKb.messageId, modelKb.buttons[0].callback_data);
	await sleep(1500);
	check("model keyboard callback not rejected as stale", !replies().some((text) => text.includes("만료")));
}
// A llama.cpp / ollama / lmstudio provider registered in models.json is missing from pi's
// "available" list (pi only lists providers it recognises as credentialed), so the bridge has to
// pull those models back in — and they belong at the top of the keyboard.
{
	const localProviders = localProviderIds(join(agentDir, "models.json"));
	if (localProviders.length) {
		const beforeLocalMenu = keyboardCount("model");
		send(CHAT, "/model");
		await waitFor(() => keyboardCount("model") > beforeLocalMenu, 20_000);
		const menuText = lastKeyboardText("model");
		// pi can list far more models than a chat can page through (openrouter alone ships hundreds), so the
		// keyboard either signposts typed references (🔎) or drills down to providers (🗂).
		check("a huge model registry is signposted instead of paged", /🔎 \d+|🗂/.test(menuText), shape(menuText));
		let currentKeyboard = lastKeyboardInfo("model");
		if (menuText.includes("🗂")) {
			const providerRows = currentKeyboard.buttons.map((button) => button.text);
			const firstLocalProvider = providerRows.findIndex((text) => text.includes("🏠"));
			const firstCloudProvider = providerRows.findIndex((text) => !text.includes("🏠"));
			check("the provider drill-down puts local providers first", firstLocalProvider >= 0 && firstCloudProvider >= firstLocalProvider, providerRows.slice(0, 4).join(" | "));
			const localProviderRow = currentKeyboard.buttons.find((button) => button.text.includes("🏠"));
			if (localProviderRow?.callback_data) {
				const beforeProviderTap = keyboardCount("model");
				tap(currentKeyboard.messageId, localProviderRow.callback_data);
				if (await waitFor(() => keyboardCount("model") > beforeProviderTap, 20_000)) currentKeyboard = lastKeyboardInfo("model");
			}
		}
		const rows = currentKeyboard.buttons.map((button) => button.text);
		const isLocalRow = (text: string) => text.includes("🏠") || localProviders.some((provider) => text.includes(provider));
		const firstLocal = rows.findIndex(isLocalRow);
		// pi-telegram pins the model in use at the top; only the rest of the list must be local-first.
		const firstCloud = rows.findIndex((text) => !isLocalRow(text) && !text.includes("●"));
		check("models from a local server are offered by /model", firstLocal >= 0, `${localProviders.join(",")} :: ${rows.slice(0, 6).join(" | ")}`);
		check("local models are listed before the cloud ones", firstLocal >= 0 && (firstCloud === -1 || firstLocal < firstCloud), `local=${firstLocal} cloud=${firstCloud} :: ${rows.slice(0, 6).join(" | ")}`);
		check("a local model is marked as local", firstLocal >= 0 && rows[firstLocal].includes("🏠"), rows[firstLocal]);
		// Selecting and restoring needs the model in use on screen; a provider page does not show it.
		const currentRow = currentKeyboard.buttons.find((button) => button.text.includes("●"));
		const localRow = currentKeyboard.buttons.find((_button, index) => index === firstLocal);
		const canRestore = !!currentRow?.callback_data && !!localRow?.callback_data;
		if (canRestore) {
			const beforeSwitch = replies().length;
			tap(currentKeyboard.messageId, localRow!.callback_data!);
			const switched = await waitFor(() => replies().slice(beforeSwitch).some((text) => /🔀 model →/.test(text)), 20_000);
			check("a local model can be selected from the keyboard", switched, shape(replies().slice(beforeSwitch).join(" | ")));
		} else {
			console.log("-- the current model is not on screen — selection checks skipped");
		}
		// a provider with hundreds of models must cap its list instead of paging forever
		const beforeFilter = keyboardCount('"openrouter"');
		send(CHAT, "/model openrouter");
		if (await waitFor(() => keyboardCount('"openrouter"') > beforeFilter, 20_000)) {
			check("filtering a huge provider caps the list instead of paging it", /✂️/.test(lastKeyboardText('"openrouter"')), shape(lastKeyboardText('"openrouter"')));
		} else {
			console.log("-- this pi has no openrouter models — big provider filter skipped");
		}
		// an id pi has never heard of is still usable: it borrows the provider's own shape
		if (canRestore) {
			const beforeUnknown = replies().length;
			send(CHAT, `/model ${localProviders[0]}/live-check-unregistered-id`);
			const unknownOk = await waitFor(() => replies().slice(beforeUnknown).some((text) => text.includes("✨")), 20_000);
			check("a model id pi has never seen is still selectable", unknownOk, shape(replies().slice(beforeUnknown).join(" | ")));
			tap(currentKeyboard.messageId, currentRow!.callback_data!);
			await sleep(2500);
		}
	} else {
		console.log("-- models.json has no localhost provider — local model checks skipped");
	}
}

// OpenRouter-style ids are typed the way the provider writes them, and pi's registry is far bigger
// than the models it calls "available" — a full id has to be understood without the provider prefix.
{
	const refs = aggregatorRefs(agentDir);
	const forced = process.env.PI_TG_LIVE_REF;
	const ref = forced ? { provider: "", id: forced } : refs.find((entry) => !entry.id.startsWith("~"));
	if (ref) {
		const before = replies().length;
		send(CHAT, `/model ${ref.id}`);
		const answered = await waitFor(() => replies().slice(before).some((text) => /🔀 model →|🔑|🚫/.test(text)), 20_000);
		const window = replies().slice(before).join(" | ");
		check("a provider-style id typed without the provider name is understood", answered && !window.includes("🚫"), shape(window));
		const applied = replies().slice(before).find((text) => text.includes("🔀 model →"));
		if (applied) check("the typed id really switches to that provider's model", applied.includes(ref.id), shape(applied));
		else console.log(`-- this pi has no credentials for ${ref.provider} — 🔑 guidance shown instead of switching`);
		// an id nobody has registered yet: the provider's own shape is borrowed, and that must still apply
		const variant = ref.id.includes(":") ? ref.id.slice(ref.id.indexOf(":")) : "";
		const bogus = `${ref.id.split("/")[0]}/pi-telegram-does-not-exist${variant}`;
		const beforeClone = replies().length;
		send(CHAT, `/model ${bogus}`);
		const cloned = await waitFor(() => replies().slice(beforeClone).some((text) => /✨|🔑|🚫/.test(text)), 20_000);
		const cloneWindow = replies().slice(beforeClone).join(" | ");
		check("an unregistered aggregator id is accepted, not refused", cloned && !cloneWindow.includes("🚫"), shape(cloneWindow));
		check("the bridge says the id is not in pi's registry", cloneWindow.includes("✨") || cloneWindow.includes("🔑"), shape(cloneWindow));
		// leave the session on a model that actually exists
		const appliedKey = /🔀 model → <code>([^<]+)<\/code>/.exec(applied ?? "")?.[1] ?? (ref.provider ? `${ref.provider}/${ref.id}` : "");
		if (appliedKey) {
			send(CHAT, `/model ${appliedKey}`);
			await sleep(2500);
		}
	} else {
		console.log("-- this pi's registry has no aggregator (openrouter-style) ids — typed id check skipped");
	}
}

await command("/thinking");
await command("/thinking low");
await command("/tools");
await command("/commands");
await command("/skills");
await command("/resume");
await command("/fork");
await command("/tree");
await command("/chats");
await command("/tg pending");
await command("/rename live check");
await command("/stream off");
await command("/bash echo live-check-output", 30_000);
await command("/export");
await command("/abort");

/** Model ids that embed their manufacturer (`openrouter` style), as pi's own config/store knows them. */
function aggregatorRefs(dir: string): { provider: string; id: string }[] {
	const refs: { provider: string; id: string }[] = [];
	for (const file of ["models.json", "models-store.json"]) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			const providers = (raw.providers && typeof raw.providers === "object" ? raw.providers : raw) as Record<string, { models?: { id?: string }[] }>;
			for (const [provider, entry] of Object.entries(providers)) {
				for (const model of entry?.models ?? []) {
					const id = typeof model?.id === "string" ? model.id : "";
					if (id.includes("/") && !id.includes(" ")) refs.push({ provider, id });
				}
			}
		} catch {
			// the shape belongs to pi; anything unexpected simply means no references to try
		}
	}
	// A plain id is a better probe than pi's `~x` "track the latest" aliases, and a `:free` variant
	// matches how people actually paste openrouter ids.
	return refs.sort(
		(a, b) =>
			Number(b.provider === "openrouter") - Number(a.provider === "openrouter") ||
			Number(b.id.startsWith("~")) - Number(a.id.startsWith("~")) ||
			Number(b.id.includes(":")) - Number(a.id.includes(":")) ||
			a.id.localeCompare(b.id),
	);
}

function localProviderIds(modelsPath: string): string[] {
	if (!existsSync(modelsPath)) return [];
	try {
		const config = JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, { baseUrl?: string }> };
		return Object.entries(config.providers ?? {})
			.filter(([, entry]) => /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(String(entry?.baseUrl ?? "")))
			.map(([id]) => id);
	} catch {
		return [];
	}
}

function keyboardCount(needle: string): number {
	return calls.filter((call) => call.method === "sendMessage" && String(call.params.text ?? "").includes(needle) && call.params.reply_markup).length;
}

// Inline keyboards that drive real pi session control (/tgexec → fork, navigateTree, switchSession).
// Each keyboard must be counted and tapped fresh: a session replacement invalidates the buttons an
// older bridge instance rendered, so waiting for "some" keyboard would tap a dead one.
for (const [heading, expect] of [["fork", /fork|새 세션/i], ["tree", /이동 완료/i], ["resume", /세션 전환/i]] as const) {
	const keyboardsBefore = keyboardCount(heading);
	send(CHAT, `/${heading}`);
	const rendered = await waitFor(() => keyboardCount(heading) > keyboardsBefore, 25_000);
	const kb = lastKeyboardInfo(heading);
	if (!rendered || !kb.buttons.length) {
		console.log(`  --   no fresh ${heading} keyboard in this environment`);
		continue;
	}
	const before = replies().length;
	tap(kb.messageId, kb.buttons[0].callback_data!);
	const answered = await waitFor(() => replies().slice(before).some((text) => expect.test(text)), 40_000);
	check(`${heading} keyboard drives pi session control`, answered, shape(replies().slice(before).join(" | ")));
	await sleep(800);
}
{
	// Render a keyboard from the live instance, then force a session replacement: the buttons on
	// screen belong to the bridge instance that just died, so they must say so instead of working.
	send(CHAT, "/model");
	await waitFor(() => lastKeyboardInfo("model").buttons.length > 0, 20_000);
	const stale = lastKeyboardInfo("model");
	if (stale.buttons.length) {
		send(CHAT, "/new");
		await waitFor(() => replies().some((text) => /새 세션|🟢/i.test(text)) && keyboardCount("model") >= 1, 20_000);
		await sleep(2500);
		tap(stale.messageId, stale.buttons[0].callback_data!);
		const toasted = await waitFor(() => calls.some((call) => call.method === "answerCallbackQuery" && /만료/.test(String(call.params.text ?? ""))), 15_000);
		check("keyboards from a replaced session explain themselves", toasted, calls.filter((call) => call.method === "answerCallbackQuery").slice(-3).map((call) => String(call.params.text ?? "")).join(" | "));
		await sleep(1500);
	}
}
{
	// the bridge instance that survived (or replaced) the session must still answer
	const before = replies().length;
	send(CHAT, "/status");
	const back = await waitFor(() => replies().slice(before).some((text) => /↔ pi|model/i.test(text)), 30_000);
	check("bridge still works after the session churn", back, scrub(replies().slice(before).join(" | ")).slice(0, 200));
}

// Commands that belong to other installed extensions must still reach pi from a phone, and the
// bridge must only add its own /tg goal on top of them.
let goalPackageLoaded = false;
{
	const before = replies().length;
	// The listing is paginated into buttons, so the names are only visible in the keyboard itself.
	send(CHAT, "/commands goal");
	await waitFor(() => replies().length > before, 20_000);
	const listing = lastKeyboardInfo("pi commands").buttons.map((button) => button.text).join(" | ");
	goalPackageLoaded = /goal-(direct|status|list|pause)/.test(listing);
	if (!goalPackageLoaded) {
		console.log("  --   pi-goal-x is not loaded in this pi — command/goal interop checks skipped");
	} else {
		check("another extension's commands reach the phone", /goal-direct/.test(listing) && /goal-list/.test(listing), scrub(listing).slice(0, 220));
		const beforeGoal = replies().length;
		send(CHAT, "/goal-list");
		const forwarded = await waitFor(() => replies().slice(beforeGoal).length > 0, 20_000);
		const goalWindow = replies().slice(beforeGoal).join(" | ");
		check("a goal-x command typed on the phone is handed to pi", forwarded && /▶️/.test(goalWindow) && !/알려진 명령이 아니에요/.test(goalWindow), scrub(goalWindow).slice(0, 220));
	}
	// /tg goal is ours: either the goal this session knows, or an honest empty state.
	const beforeTgGoal = replies().length;
	send(CHAT, "/tg goal");
	const cardArrived = await waitFor(() => replies().slice(beforeTgGoal).length > 0, 20_000);
	const card = replies().slice(beforeTgGoal).join(" | ");
	check("/tg goal answers with a card or an honest empty state", cardArrived && /🎯/.test(card) && !/❌|⚠️| failed:/.test(card), scrub(card).slice(0, 240));
}

// Attachments: photo download path, then an unsupported attachment type.
sendPhoto(CHAT, "photo-1", "what do you see in this photo?");
await sleep(1500);
check("photo attachment did not crash the bridge", calls.some((call) => call.method === "getFile"));
sendVoice(CHAT);
await waitFor(() => /음성|voice|지원/i.test(replies().at(-1) ?? ""), 8000);
check("unsupported attachment explained", /음성|voice|지원/i.test(replies().at(-1) ?? ""), scrub(replies().at(-1) ?? "").slice(0, 160));
// pi refuses prompts while it rebuilds its context ("Cannot submit a prompt while compaction is in
// progress"), and pi reports that only as an internal error — so a chat message used to vanish here.
send(CHAT, "/compact");
const compactWindow = replies().length;
const compactNoticeSeen = await waitFor(() => replies().slice(compactWindow).some((text) => /컨텍스트 압축 (중|완료|실패|중단)/.test(text)), 10_000);
check("the chat is told what happened to the compaction", compactNoticeSeen, scrub(replies().slice(compactWindow).join(" | ")).slice(0, 200));
await sleep(600);
const beforeCompaction = replies().length;
send(CHAT, "a message sent right around compaction");
const parked = await waitFor(() => replies().slice(beforeCompaction).some((text) => /컨텍스트를 압축\/요약 중/.test(text)), 5000);
await sleep(4000);
const compactionOutcome = replies().slice(beforeCompaction).join(" | ");
check(
	"a message sent during compaction is neither dropped nor shown as a send failure",
	!/pi에 보내지 못했어요|Cannot submit a prompt/i.test(compactionOutcome),
	scrub(compactionOutcome).slice(0, 200),
);
check("compaction either parks the message or pi takes it directly", parked || /압축|pong|❌|⚠️/i.test(compactionOutcome), scrub(compactionOutcome).slice(0, 200));

if (!skipPrompt) {
	// let earlier notices land first, so whatever arrives now belongs to this prompt
	await sleep(3000);
	const beforePrompt = replies().length;
	send(CHAT, "Reply with exactly one word: pong");
	const delivered = await waitFor(() => replies().length > beforePrompt, 90_000);
	const outcome = replies().slice(beforePrompt).join(" | ");
	// A provider failure (expired key, rate limit) or a blocked run is fine here — silence is not.
	check("prompt produced an answer or a visible failure", delivered && !/생각 중/.test(outcome), scrub(outcome).slice(0, 200));
	check("a prompt pi cannot run still explains itself", /❌|⚠️/.test(outcome) || /pong/i.test(outcome), scrub(outcome).slice(0, 200));
	check("model failures are reported in chat, not swallowed", !/❌/.test(outcome) || /Key limit|403|exceeded/i.test(outcome), scrub(outcome).slice(0, 200));
	await sleep(2000);
}

if (goalPackageLoaded && process.env.PI_TG_LIVE_GOAL === "1") {
	// The real interop proof: pi-goal-x puts its goal record in its tool results, and the bridge has
	// to read that shape without knowing the extension. Needs a model, so it is opt-in.
	const beforeGoalPrompt = replies().length;
	send(CHAT, "Call the create_goal tool right now with the objective exactly: live-check goal for pi-telegram. Do not start working on it.");
	const goalNewsArrived = await waitFor(() => replies().slice(beforeGoalPrompt).some((text) => /🎯 <b>goal<\/b>/.test(text)), 150_000);
	const goalWindow = replies().slice(beforeGoalPrompt).join(" | ");
	if (/No API key|Key limit|403|exceeded|not logged in/i.test(goalWindow)) {
		console.log("  --   no usable provider — pi-goal-x interop check skipped");
	} else {
		check("pi-goal-x announces its goal to the phone by itself", goalNewsArrived, scrub(goalWindow).slice(0, 300));
		const beforeCard = replies().length;
		send(CHAT, "/tg goal");
		const cardArrived = await waitFor(() => replies().slice(beforeCard).length > 0, 20_000);
		const card = replies().slice(beforeCard).join(" | ");
		check("/tg goal shows the objective pi-goal-x created", cardArrived && /live-check goal for pi-telegram/.test(card), scrub(card).slice(0, 300));
	}
}

// Anything the bridge generates about a failure must be safe to read on a phone: provider errors
// often quote the request, which contains the key and a signed URL path. Only bridge-generated
// notices are in scope — a model answer that mentions a url is the user's content, not a leak.
const notices = replies().filter((text) => /❌|⚠️|bridge-internal|failed|error|failure/i.test(text));
const leaky = notices.filter((text) => /\b(?:sk|key|ghp|xox[baprs]|AKIA|AIza)[A-Za-z0-9_-]{12,}\b/i.test(text) || /\b(?:api[_ -]?key|token|secret|authorization|bearer)\s*[:=]\s*\S+/i.test(text));
check("failure notices carry no credential material", leaky.length === 0, leaky.map(scrub).join(" | ").slice(0, 300));
const urlPaths = notices.filter((text) => /https?:\/\/[^\s]*[/?][^\s]*/i.test(text));
check("failure notices reduce provider urls to their host", urlPaths.length === 0, urlPaths.map(scrub).join(" | ").slice(0, 300));

// A missing provider key or a spent key is an environment problem, not a bridge bug. It is still
// expected to be visible in the chat — checked separately below.
const envError = /No API key found|Key limit|403|exceeded|not logged in/i;
const reported = [...stderrLines, ...stdoutLines].filter((line) => /Cannot read properties|is not a function|extension_error|extension error/i.test(line));
const suspect = reported.filter((line) => !envError.test(line));
const envCount = reported.filter((line) => envError.test(line)).length;
if (envCount) console.log(`  --   ${envCount} provider-configuration error(s) from pi (environment, not the bridge)`);
check("pi reported no unexpected extension errors", suspect.length === 0, suspect.slice(0, 3).join(" | ").slice(0, 500));
if (envCount) {
	check("a run pi cannot execute still shows up in the chat", replies().some((text) => /❌|⚠️/.test(text)), replies().slice(-8).map(scrub).join(" | ").slice(0, 400));
}
console.log(`\nui dialogs answered: ${uiRequests.length ? uiRequests.join(" | ") : "none"}`);
const internal = replies().filter((text) => / failed:/.test(text) && !/컨텍스트 압축/.test(text));
check("no bridge-internal failure notices", internal.length === 0, internal.slice(0, 2).map(scrub).join(" | ").slice(0, 300));
check("bridge replied to the command barrage", replies().length > 20, `${replies().length} messages`);

child.stdin.write(`${JSON.stringify({ id: "bye", type: "shutdown" })}\n`);
await sleep(500);
child.kill();
server.close();

console.log("\nreplies seen:");
for (const text of replies().slice(0, 40)) console.log(`  · ${shape(text)}`);
if (stderrLines.length) {
	console.log("\npi stderr:");
	for (const line of stderrLines.filter((line) => line.includes("[pi-telegram]")).slice(-90)) console.log(`  ${line.slice(0, 200)}`);
	console.log("\nraw pi stderr (last 20):");
	for (const line of stderrLines.slice(-20)) console.log(`  ${line.slice(0, 200)}`);
}
console.log(`\n${failures === 0 ? "live check passed" : "live check FAILED"} · ${calls.length} telegram calls · ${replies().length} replies`);
process.exit(failures === 0 ? 0 : 1);
