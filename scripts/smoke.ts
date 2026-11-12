/**
 * End-to-end smoke test: no network, no real bot.
 *
 * Runs the real extension against (a) a mock Telegram Bot API server on 127.0.0.1 driven
 * through TELEGRAM_API_ROOT, and (b) a fake pi ExtensionAPI that records calls and fires the
 * events a real pi session fires.
 *
 *   node scripts/smoke.ts        (or: npm run smoke)
 *
 * Covers: pairing gate and code guessing, prompts, answers (draft-in-place vs chunked), per-turn tool
 * summaries, verbosity levels, inline keyboards for model/thinking/tools/commands/resume/fork/tree/chats,
 * command passthrough, attachments, /bash, /export, /compact, /abort, /steer, /queue, telegram_send,
 * telegram_ask, multi-chat mirroring, credential scrubbing, flood control, cross-chat keyboards,
 * config persistence and file permissions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { draftHtml, mdToHtml, toHtmlChunks } from "../src/format.ts";
import { TelegramBot } from "../src/telegram.ts";

// ── isolated pi dir + workspace before any project import ──────────────────────────
const agentDir = mkdtempSync(join(tmpdir(), "pi-tg-agent-"));
const workDir = mkdtempSync(join(tmpdir(), "pi-tg-work-"));
const sessionsRoot = join(workDir, "sessions");
// pi keeps one folder per project: <agentDir>/sessions/<encoded cwd>/<timestamp>_<id>.jsonl
const sessionDir = join(sessionsRoot, "--work-current--");
const foreignDir = join(sessionsRoot, "--work-other--");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(foreignDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TELEGRAM_BOT_TOKEN = "123456:FAKE-TOKEN-for-smoke";

const configPath = join(agentDir, "telegram.json");
const currentSessionFile = join(sessionDir, "2026-01-01T00-00-00-000Z_current.jsonl");
const otherSessionFile = join(sessionDir, "2026-01-01T00-00-00-001Z_older.jsonl");
const foreignSessionFile = join(foreignDir, "2026-01-01T00-00-00-002Z_foreign.jsonl");
writeFileSync(
	otherSessionFile,
	[
		JSON.stringify({ type: "session", version: 3, id: "older", timestamp: "2026-01-01T00:00:00.000Z", cwd: workDir }),
		JSON.stringify({ type: "message", id: "x1", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "user", content: [{ type: "text", text: "older session about the parser" }] } }),
	].join("\n"),
	"utf8",
);
writeFileSync(
	currentSessionFile,
	[JSON.stringify({ type: "session", version: 3, id: "current-session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: workDir })].join("\n"),
	"utf8",
);
// Another project, touched more recently: /resume must still put this project first.
writeFileSync(
	foreignSessionFile,
	[
		JSON.stringify({ type: "session", version: 3, id: "foreign", timestamp: "2026-01-01T00:00:00.000Z", cwd: join(workDir, "other") }),
		JSON.stringify({ type: "message", id: "x2", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "user", content: [{ type: "text", text: `foreign session about deploys ${"x".repeat(160)}` }] } }),
	].join("\n"),
	"utf8",
);
const stamp = (path: string, iso: string) => utimesSync(path, new Date(iso), new Date(iso));
stamp(currentSessionFile, "2026-01-01T00:00:00.000Z");
stamp(otherSessionFile, "2026-01-01T00:00:01.000Z");
stamp(foreignSessionFile, "2027-01-01T00:00:00.000Z");

// ── mock Telegram Bot API ─────────────────────────────────────────────────────────
interface Call {
	method: string;
	params: Record<string, unknown>;
	/** Message id this call created or targeted — used to prove delivered messages survive. */
	id?: number;
}

const calls: Call[] = [];
const apiLog: string[] = [];
let updateQueue: Record<string, unknown>[] = [];
let pollGate: Promise<void> | undefined;
const servedMenu = new Map<string, string[]>();
let shadowMenu = false;

/** Park the next in-flight long poll (like Telegram holding one open for 25s) and hand back a releaser. */
function holdNextPoll(): () => void {
	let release: () => void = () => undefined;
	pollGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return () => release();
}
let updateId = 1000;
let messageId = 5000;
let callbackSeq = 0;
const jpegBytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9];

function findCall(method: string, predicate?: (params: Record<string, unknown>) => boolean): Call | undefined {
	return calls.filter((call) => call.method === method && (!predicate || predicate(call.params))).at(-1);
}

/** sendMessage calls (new messages). */
function sentMessages(needle?: string): Call[] {
	return calls.filter((call) => call.method === "sendMessage" && (needle === undefined || String(call.params.text ?? "").includes(needle)));
}

/** Short one-line form of a message for failure diagnostics. */
function shapeText(value: string): string {
	return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 160);
}

/** sendMessage + editMessageText (drafts end up as edits). */
function textMessages(needle?: string): Call[] {
	return calls.filter(
		(call) => (call.method === "sendMessage" || call.method === "editMessageText") && (needle === undefined || String(call.params.text ?? "").includes(needle)),
	);
}

function keyboardOf(call: Call | undefined): { text: string; callback_data: string }[][] {
	const markup = call?.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined;
	return markup?.inline_keyboard ?? [];
}

function lastKeyboard(needle: string) {
	return keyboardOf(sentMessages(needle).filter((call) => call.params.reply_markup).at(-1));
}

function buttons(rows: { text: string; callback_data: string }[][]): { text: string; callback_data: string }[] {
	return rows.flat();
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "GET" && url.pathname.includes("/file/bot")) {
		res.writeHead(200, { "content-type": "image/jpeg" });
		res.end(Buffer.from(jpegBytes));
		return;
	}
	const method = url.pathname.split("/").pop() ?? "";
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", async () => {
		const raw = Buffer.concat(chunks);
		const contentType = String(req.headers["content-type"] ?? "");
		let params: Record<string, unknown> = {};
		if (contentType.includes("application/json")) {
			try {
				params = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			} catch {
				/* ignore */
			}
		} else if (contentType.includes("multipart/form-data")) {
			const text = raw.toString("latin1");
			params = {
				chat_id: Number(/name="chat_id"\r\n\r\n(-?\d+)/.exec(text)?.[1] ?? 0),
				file_name: /name="(?:document|photo)"; filename="([^"]*)"/.exec(text)?.[1],
				caption: /name="caption"\r\n\r\n([^\r]*)/.exec(text)?.[1],
			};
		}
		calls.push({ method, params });
		apiLog.push(`${method}:${String(params.text ?? params.file_name ?? "").replace(/\s+/g, " ").slice(0, 90)}`);

		const json = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, result }));
		};
		const message = (extra: Record<string, unknown> = {}) => {
			const created = {
				message_id: ++messageId,
				chat: { id: Number(params.chat_id ?? 0), type: "private", first_name: "Tester" },
				date: Math.floor(Date.now() / 1000),
				...extra,
			};
			const last = calls[calls.length - 1];
			if (last) last.id = Number(params.message_id ?? created.message_id);
			return created;
		};

		switch (method) {
			case "getMe":
				return json({ id: 77, is_bot: true, first_name: "PiBridge", username: "pi_bridge_smoke_bot" });
			case "getUpdates": {
				// A poll can be parked deliberately (holdNextPoll) to prove an idle long poll never
				// delays an outbound message.
				const gate = pollGate;
				pollGate = undefined;
				if (gate) await gate;
				const drained = updateQueue;
				updateQueue = [];
				return json(drained);
			}
			case "sendMessage":
				return json(message({ text: String(params.text ?? "") }));
			case "editMessageText":
				return json(message({ text: String(params.text ?? ""), edited: true }));
			case "sendDocument":
			case "sendPhoto":
				return json(message({ caption: params.caption }));
			case "getFile":
				return json({ file_id: params.file_id, file_path: String(params.file_id).startsWith("doc") ? "fake/notes.md" : "fake/photo.jpg" });
			case "setMyCommands": {
				const list = (params.commands ?? []) as { command: string }[];
				const scope = String((params.scope as { type?: string } | undefined)?.type ?? "default");
				servedMenu.set(scope, list.map((entry) => entry.command));
				return json(true);
			}
			case "getMyCommands": {
				const scope = String((params.scope as { type?: string } | undefined)?.type ?? "default");
				const names = [...(servedMenu.get(scope) ?? [])];
				// A second program using the same bot token overwrites the menu; reproduce that here.
				const list = shadowMenu ? [...names.filter((name) => name !== "tg"), "goal", "heartbeat", "moa"] : names;
				return json(list.map((command) => ({ command, description: command })));
			}
			default:
				return json(true);
		}
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
process.env.TELEGRAM_API_ROOT = `http://127.0.0.1:${port}`;

function pushMessage(chatId: number, text: string, extra: Record<string, unknown> = {}): void {
	updateQueue.push({
		update_id: ++updateId,
		message: {
			message_id: ++messageId,
			from: { id: 900, first_name: "Tester" },
			chat: { id: chatId, type: "private", first_name: "Tester" },
			date: Math.floor(Date.now() / 1000),
			text,
			...extra,
		},
	});
}

function pushEdited(chatId: number, text: string): void {
	updateQueue.push({
		update_id: ++updateId,
		edited_message: {
			message_id: ++messageId,
			from: { id: 900, first_name: "Tester" },
			chat: { id: chatId, type: "private", first_name: "Tester" },
			date: Math.floor(Date.now() / 1000),
			text,
		},
	});
}

function pushCallback(chatId: number, message: number, data: string): void {
	updateQueue.push({
		update_id: ++updateId,
		callback_query: {
			id: `cb${++callbackSeq}`,
			from: { id: 900, first_name: "Tester" },
			message: { message_id: message, chat: { id: chatId, type: "private", first_name: "Tester" }, date: Math.floor(Date.now() / 1000) },
			data,
		},
	});
}

// ── fake pi ───────────────────────────────────────────────────────────────────────
/** Set while delivering a prompt pi should not accept, so no agent_start is emitted. */
let suppressRunStart = false;

interface FakeModel {
	type?: string;
	provider: string;
	id: string;
	name: string;
	baseUrl?: string;
	contextWindow: number;
	reasoning: boolean;
}

const models: FakeModel[] = [
	{ type: "chat", provider: "mock", id: "mock-model", name: "Mock Model", contextWindow: 200_000, reasoning: true },
	{ type: "chat", provider: "other", id: "second-model", name: "Second Model", contextWindow: 128_000, reasoning: false },
	{ type: "embedding", provider: "other", id: "embedder", name: "Not A Chat", contextWindow: 8000, reasoning: false },
	// a models.json registration carries no `type` at all
	{ provider: "custom", id: "no-type-model", name: "No Type Model", contextWindow: 100_000, reasoning: false },
];

// pi calls a model "available" only when its provider has credentials it recognises, so a llama.cpp
// or ollama server on localhost is missing from getAvailable() — that is exactly what real pi does.
const localModels: FakeModel[] = [
	{ provider: "ninfer-local", id: "qwen3.8-27b", name: "Qwen3.8 27B (llama.cpp)", baseUrl: "http://127.0.0.1:18080/v1", contextWindow: 32_768, reasoning: true },
	{ provider: "ollama", id: "qwen3:30b-a3b", name: "Qwen3 30B A3B", baseUrl: "http://localhost:11434/v1", contextWindow: 32_768, reasoning: false },
	// a keyless *cloud* model must not be smuggled in just because it exists
	{ provider: "veolia", id: "kimi-k2.6", name: "No Credentials Cloud", baseUrl: "https://api.veolia.dev/v1", contextWindow: 200_000, reasoning: false },
];
const providers: { id: string; baseUrl?: string }[] = [
	{ id: "groq", baseUrl: "https://api.groq.com/openai/v1" },
	{ id: "ninfer-local", baseUrl: "http://127.0.0.1:18080/v1" },
	{ id: "bulkprov", baseUrl: "https://bulk.example/v1" },
];

// providers like openrouter sit in the registry but not in getAvailable(), in numbers nobody can page
// through — the bridge has to resolve typed references against the whole registry.
const extraModels: FakeModel[] = [];

const allTools: { name?: string; description?: string }[] = [
	{ name: "read", description: "Read a file" },
	{ name: "bash", description: "Run a shell command" },
	{ name: "edit", description: "Edit a file" },
	{ name: "write", description: "Write a file" },
	{ name: "grep", description: "Search file contents" },
	{ name: "telegram_send", description: "Send to Telegram" },
];

const piCommands: { name?: string; description?: string; source?: string }[] = [
	{ name: "review", description: "Review the current diff", source: "prompt-template" },
	{ name: "pdf", description: "Work with a PDF", source: "skill" },
	{ name: "telegram", description: "Telegram bridge", source: "extension" },
];

const sessionEntries = [
	{ type: "model_change", id: "e1", timestamp: "2026-01-01T00:00:00.000Z", modelId: "mock-model", provider: "mock", parentId: null },
	{ type: "message", id: "e2", timestamp: "2026-01-01T00:01:00.000Z", parentId: "e1", message: { role: "user", content: [{ type: "text", text: "first prompt in this session" }] } },
	{ type: "message", id: "e3", timestamp: "2026-01-01T00:02:00.000Z", parentId: "e2", message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } },
	{ type: "message", id: "e4", timestamp: "2026-01-01T00:03:00.000Z", parentId: "e3", message: { role: "user", content: [{ type: "text", text: "second prompt to fork from" }] } },
];

const notices: { message: string; level: string }[] = [];
const statuses: Record<string, string | undefined> = {};
const userMessages: { content: unknown; options?: { deliverAs?: string; expandPromptTemplates?: boolean } }[] = [];
const execCalls: { command: string; args: string[] }[] = [];
const sessionOps: string[] = [];
const compactions: unknown[] = [];
let idle = true;
let aborted = false;
let activeTools = ["read", "bash", "edit", "write", "grep"];
let thinkingLevel = "medium";
let sessionName: string | undefined = "smoke session";

const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
const registeredTools: { name: string; parameters: unknown; execute: (...args: unknown[]) => unknown }[] = [];
const registeredFlags = new Set<string>();

const ctx = {
	mode: "rpc",
	hasUI: true,
	cwd: workDir,
	model: models[0],
	scopedModels: [],
	thinkingLevel,
	isIdle: () => idle,
	isProjectTrusted: () => true,
	signal: undefined,
	abort: () => {
		aborted = true;
	},
	hasPendingMessages: () => false,
	shutdown: () => undefined,
	getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
	compact: (options?: unknown) => {
		compactions.push(options);
	},
	getSystemPrompt: () => "system prompt",
	ui: {
		notify: (message: string, level = "info") => notices.push({ message, level }),
		setStatus: (key: string, value: string | undefined) => {
			statuses[key] = value;
		},
		setTitle: () => undefined,
		setWidget: () => undefined,
	},
	sessionManager: {
		getSessionId: () => "current-session-id",
		getSessionFile: () => currentSessionFile,
		getSessionDir: () => sessionDir,
		getCwd: () => workDir,
		getEntries: () => sessionEntries,
		getBranch: () => sessionEntries,
		getLeafId: () => "e4",
		getLeafEntry: () => sessionEntries.at(-1),
		getEntry: (id: string) => sessionEntries.find((entry) => entry.id === id),
		getLabel: () => undefined,
		getHeader: () => ({ type: "session", version: 3, id: "current-session-id", timestamp: "2026-01-01T00:00:00.000Z", cwd: workDir }),
		getTree: () => [],
		getSessionName: () => sessionName,
	},
	modelRegistry: {
		getAvailable: () => models,
		getAll: () => [...models, ...localModels, ...extraModels],
		getProvider: (id: string) => providers.find((provider) => provider.id === id),
		getProviderAuthStatus: (provider: string) => ({ configured: !provider.endsWith("-local") && !["veolia", "bulkprov"].includes(provider) }),
	},
	newSession: async () => {
		sessionOps.push("newSession");
	},
	switchSession: async (path: string) => {
		sessionOps.push(`switchSession:${String(path).split("/").pop()}`);
	},
	fork: async (entryId: string) => {
		sessionOps.push(`fork:${entryId}`);
	},
	navigateTree: async (entryId: string) => {
		sessionOps.push(`navigateTree:${entryId}`);
	},
	reload: async () => {
		sessionOps.push("reload");
	},
};

const fakePi: Record<string, unknown> = {
	on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
	},
	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
		commandHandlers.set(name, options.handler);
	},
	registerTool(tool: { name: string; parameters: unknown; execute: (...args: unknown[]) => unknown }) {
		registeredTools.push(tool);
	},
	registerFlag(name: string) {
		registeredFlags.add(name);
	},
	getFlag(name: string) {
		return name === "telegram-off" ? false : undefined;
	},
	getCommands: () => piCommands,
	sendUserMessage(content: unknown, options?: { deliverAs?: string; expandPromptTemplates?: boolean }) {
		userMessages.push({ content, options });
		const text = typeof content === "string" ? content : String((content as { text?: string }[])?.[0]?.text ?? "");
		const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
		// pi executes extension commands synchronously inside sendUserMessage (rpc/interactive),
		// so deferring here would hide ordering bugs that only show up against real pi.
		if (match && commandHandlers.has(match[1])) {
			const handler = commandHandlers.get(match[1])!;
			void handler(match[2] ?? "", ctx);
			return;
		}
		// A prompt pi accepts starts a run right away; the bridge's prompt watchdog waits for that.
		if (!suppressRunStart) emit("agent_start", { type: "agent_start" });
	},
	getActiveTools: () => activeTools,
	getAllTools: () => allTools,
	setActiveTools: (names: string[]) => {
		activeTools = names;
	},
	getModel: () => ctx.model,
	setModel: async (model: FakeModel) => {
		ctx.model = model;
		return true;
	},
	getThinkingLevel: () => thinkingLevel,
	setThinkingLevel: (level: string) => {
		thinkingLevel = level;
		ctx.thinkingLevel = level;
	},
	setSessionName: (name: string) => {
		sessionName = name;
	},
	getSessionName: () => sessionName,
	isIdle: () => idle,
	exec: async (command: string, args: string[]) => {
		execCalls.push({ command, args });
		return { stdout: `executed ${args.join(" ")}`, stderr: "", code: 0, killed: false, truncated: false };
	},
};

/** Every prompt the bridge has pushed into pi, flattened to text. */
function promptText(): string {
	return userMessages
		.map((entry) =>
			typeof entry.content === "string" ? entry.content : (entry.content as { type?: string; text?: string }[]).map((part) => part.text ?? "").join("\n"),
		)
		.join("\n");
}

function emit(name: string, event: unknown): void {
	for (const handler of handlers.get(name) ?? []) handler(event, ctx);
}

/** pi awaits event handlers, so lifecycle events must settle before the next one is delivered. */
async function emitAwait(name: string, event: unknown): Promise<void> {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

// ── run ───────────────────────────────────────────────────────────────────────────
const { default: piTelegram } = await import("../index.ts");
piTelegram(fakePi as never);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${description}\nrecent api: ${apiLog.slice(-14).join(" | ")}`);
		await sleep(20);
	}
}

let failures = 0;
let checks = 0;
function check(description: string, ok: boolean, detail = ""): void {
	checks += 1;
	if (ok) {
		console.log(`  ok   ${description}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ""}`);
	console.log(`       ${apiLog.slice(-8).join(" | ")}`);
}

const CHAT = 555000111;
const OTHER = 555000222;
/** Mirrors of the bridge's flood budgets — the test asserts the cap on purpose. */
const UNPAIRED_ALLOWANCE = 10;
const PAIRED_ALLOWANCE = 60;
const EXTRA = 777000333;

console.log("pi-telegram smoke test");

// 1. load + connect
emit("session_start", { reason: "startup" });
await waitFor("getMe + setMyCommands", () => calls.some((call) => call.method === "getMe") && calls.some((call) => call.method === "setMyCommands"));
const menu = (findCall("setMyCommands")?.params.commands ?? []) as { command: string }[];
check("connects and registers the Telegram command menu", menu.length >= 20, `${menu.length} entries`);
check("registers the bridge tools for pi", registeredTools.some((tool) => tool.name === "telegram_send") && registeredTools.some((tool) => tool.name === "telegram_ask"), registeredTools.map((tool) => tool.name).join(","));
check("registers pi-side management commands", ["telegram", "telegram-setup", "telegram-pair", "telegram-chats", "telegram-verbose"].every((name) => commandHandlers.has(name)), [...commandHandlers.keys()].join(","));
check("registers CLI flags", registeredFlags.has("telegram-off") && registeredFlags.has("telegram-token"), [...registeredFlags].join(","));

// 2. pairing gate
pushMessage(OTHER, "hello?");
await waitFor("pairing prompt", () => sentMessages("pairing 필요").some((call) => Number(call.params.chat_id) === OTHER));
const pairingNotice = notices.find((notice) => notice.message.includes("pairing request"));
const code = /code (\d{4,6})/.exec(pairingNotice?.message ?? "")?.[1];
check("unpaired chat is gated with a pairing request", Boolean(code), `notice=${pairingNotice?.message ?? "(none)"}`);
check("pairing code is not leaked to the unpaired chat", !lastTextFor(OTHER).includes(code ?? "0000"), lastTextFor(OTHER).slice(0, 120));

pushMessage(OTHER, "0000");
await sleep(200);
check("wrong code does not pair the chat", !textMessages("pairing approved").length);
commandHandlers.get("telegram-pair")?.(code ?? "", ctx);
await waitFor("pi-side approval", () => textMessages("pairing approved").some((call) => Number(call.params.chat_id) === OTHER));
check("pi-side /telegram-pair <code> approves the chat", true);
commandHandlers.get("telegram")?.("add 555000111", ctx);
await waitFor("operator chat paired", () => readFileSync(configPath, "utf8").includes(String(CHAT)));
check("/telegram add <chatId> pairs a chat", true);

// 2b. the pairing code is the only gate between a stranger and a shell-capable pi session
check("pairing codes are six digits", /^\d{6}$/.test(code ?? ""), `code=${code ?? "(none)"}`);
const BRUTE = 555000444;
for (let attempt = 0; attempt < 6; attempt += 1) pushMessage(BRUTE, String(100000 + attempt));
await waitFor("code guessing locked out", () => textMessages("코드를 여러 번 틀렸어요").some((call) => Number(call.params.chat_id) === BRUTE), 8000);
check("guessing pairing codes rotates the code", true);
check(
	"a code-guessing attempt is reported to the operator",
	notices.some((notice) => /guessed pairing codes/i.test(notice.message)),
	notices.map((notice) => notice.message).join(" | ").slice(0, 200),
);
pushMessage(BRUTE, "123456");
await waitFor("cooldown notice", () => textMessages("일시 정지").some((call) => Number(call.params.chat_id) === BRUTE), 8000);
check("a cooled-down chat is not handed another set of guesses", true);
commandHandlers.get("telegram-pair")?.("", ctx);
await waitFor("pending list shows a rotated code", () => notices.some((notice) => notice.message.includes("pending:") && new RegExp(`\\(${BRUTE}\\) → code \\d{6}`).test(notice.message)));
const bruteCodes = notices
	.filter((notice) => notice.message.includes(String(BRUTE)))
	.flatMap((notice) => [...notice.message.matchAll(new RegExp(`\\(${BRUTE}\\) → code (\\d{6})`, "g"))].map((match) => match[1]));
const rotated = bruteCodes.at(-1);
check("guessing rotates the code, and only the operator sees it", bruteCodes.length >= 2 && rotated !== bruteCodes[0], bruteCodes.join(" -> ") || "(no codes)");
commandHandlers.get("telegram-pair")?.(rotated ?? "", ctx);
await waitFor("rotated code pairs from the pi side", () => textMessages("pairing approved").some((call) => Number(call.params.chat_id) === BRUTE), 8000);
check("the operator can still approve the rotated code", true);
pushMessage(BRUTE, "/tg unpair");
await waitFor("the guessed chat is revoked", () => textMessages("허용 목록에서 뺐어요").some((call) => Number(call.params.chat_id) === BRUTE), 8000);
check("a chat guessed into can be revoked again", true);

// 3. plain prompt -> pi
pushMessage(CHAT, "hello pi, please read src/index.ts");
await waitFor("prompt delivered", () => userMessages.some((entry) => String(entry.content).includes("hello pi")));
check("plain text becomes a pi prompt", true);

// 4. answer mirroring: live draft, then the draft becomes the final answer
idle = false;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Working on **it**" }] } });
await waitFor("draft created", () => textMessages("Working on").length > 0, 12_000);
emit("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Working on **it** now" }] } });
await waitFor("draft edited", () => calls.some((call) => call.method === "editMessageText" && String(call.params.text).includes("now")), 12_000);
emit("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Working on **it** now — the <answer>:\n\n```ts\nconst x = 1;\n```" }],
		usage: { input: 1200, output: 340, totalTokens: 1540, cost: { total: 0.0031 } },
		durationMs: 12_300,
	},
});
emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/index.ts" } });
emit("tool_execution_end", {
	type: "tool_execution_end",
	toolCallId: "t1",
	toolName: "read",
	result: { content: [{ type: "text", text: "file body here" }] },
	isError: false,
	durationMs: 90,
});
emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", usage: { input: 1200, output: 340, totalTokens: 1540, cost: { total: 0.0031 } }, durationMs: 12_300 } });
emit("agent_end", { type: "agent_end" });
emit("agent_settled", { type: "agent_settled", aborted: false });
await waitFor("final answer delivered", () => textMessages("const x = 1;").length > 0);
await waitFor("turn summary", () => textMessages("이번 턴").length > 0);

const answer = String(textMessages("const x = 1;").at(-1)?.params.text ?? "");
check("answer arrives in the live draft (edited in place)", calls.some((call) => call.method === "editMessageText" && String(call.params.text).includes("const x = 1;")), answer.slice(0, 80));
check("markdown becomes Telegram HTML with escaping", answer.includes("<pre>") && answer.includes("&lt;answer&gt;") && answer.includes("<b>it</b>"), answer.slice(0, 120));
check("per-turn tool summary at default detail", textMessages("이번 턴").some((call) => String(call.params.text).includes("read")), String(textMessages("이번 턴").at(-1)?.params.text).slice(0, 140));
check("prompt typed in Telegram is not echoed back", !textMessages("please read src/index.ts").some((call) => Number(call.params.chat_id) === CHAT && !String(call.params.text).startsWith("/")));
check("pi-side status widget shows the bridge", Object.keys(statuses).length > 0, JSON.stringify(statuses));
const order = apiLog.findIndex((line) => line.includes("이번 턴"));
const answerAt = apiLog.findIndex((line) => line.includes("const x = 1;"));
check("answer is delivered before its tool summary", answerAt >= 0 && answerAt < order, `answer=${answerAt} summary=${order}`);

// 5. /model list + inline keyboard switches the model
pushMessage(CHAT, "/model");
await waitFor("model list", () => lastKeyboard("model").length > 0);
const modelRows = lastKeyboard("model");
check("model buttons carry server-side tokens", buttons(modelRows).every((button) => button.callback_data.startsWith("t:")), JSON.stringify(buttons(modelRows)[0]));
check("non-chat models are filtered out", !JSON.stringify(modelRows).includes("Not A Chat"), JSON.stringify(modelRows).slice(0, 220));
check("current model is marked", JSON.stringify(modelRows).includes("●"));
const pick = buttons(modelRows).find((button) => button.text.includes("Second Model"))!;
pushCallback(CHAT, Number(sentMessages("model").at(-1)?.params.message_id ?? 0), pick.callback_data);
await waitFor("model switched", () => ctx.model.id === "second-model");
check("keyboard callback switches the model through pi", ctx.model.id === "second-model", ctx.model.id);
await waitFor("model change confirmed in chat", () => textMessages("🔀 model →").length > 0);
check("model change confirmed in chat", true);

// 6. thinking / status / usage / rename
pushMessage(CHAT, "/thinking high");
await waitFor("thinking changed", () => thinkingLevel === "high");
check("/thinking high sets the thinking level", true);
pushMessage(CHAT, "/thinking");
await waitFor("thinking keyboard", () => lastKeyboard("thinking").length > 0);
pushCallback(CHAT, Number(sentMessages("thinking").at(-1)?.params.message_id ?? 0), buttons(lastKeyboard("thinking")).find((b) => b.text.includes("low"))!.callback_data);
await waitFor("thinking from keyboard", () => thinkingLevel === "low");
check("thinking keyboard works", true);
pushMessage(CHAT, "/status");
await waitFor("status reply", () => textMessages("↔ pi").length > 0);
const statusText = String(textMessages("↔ pi").at(-1)?.params.text ?? "");
check("/status shows model, session, usage, tools, detail", ["other/second-model", "smoke session", "21.0%", "read", "detail"].every((needle) => statusText.includes(needle)), statusText.slice(0, 300));
pushMessage(CHAT, "/usage");
await waitFor("usage reply", () => textMessages("▰").length > 0);
check("/usage renders a context bar with token counts", textMessages("42.0k / 200.0k").length > 0);
pushMessage(CHAT, "/rename telegram session");
await waitFor("renamed", () => sessionName === "telegram session");
check("/rename sets the session name", true);

// 7. tools keyboard toggles active tools
pushMessage(CHAT, "/tools");
await waitFor("tools keyboard", () => lastKeyboard("tools").length > 0);
const toolsMsg = sentMessages("tools").filter((call) => call.params.reply_markup).at(-1)!;
pushCallback(CHAT, Number(toolsMsg.params.message_id ?? 0), buttons(lastKeyboard("tools")).find((b) => b.text.includes("edit"))!.callback_data);
await waitFor("edit tool off", () => !activeTools.includes("edit"));
check("tools keyboard toggles a tool off", true);
pushMessage(CHAT, "/tools");
await waitFor("second tools keyboard", () => sentMessages("tools").filter((call) => call.params.reply_markup).length >= 2);
const toolsMsg2 = sentMessages("tools").filter((call) => call.params.reply_markup).at(-1)!;
pushCallback(CHAT, Number(toolsMsg2.params.message_id ?? 0), buttons(keyboardOf(toolsMsg2)).find((b) => b.text.includes("edit"))!.callback_data);
await waitFor("edit tool back on", () => activeTools.includes("edit"));
check("tools keyboard toggles it back on", true);

// 8. /commands keyboard runs a prompt template; unknown + terminal-only commands
pushMessage(CHAT, "/commands");
await waitFor("commands keyboard", () => lastKeyboard("pi commands").length > 0);
pushCallback(CHAT, Number(sentMessages("pi commands").at(-1)?.params.message_id ?? 0), buttons(lastKeyboard("pi commands")).find((b) => b.text.includes("review"))!.callback_data);
await waitFor("template command sent to pi", () => userMessages.some((entry) => entry.content === "/review" && entry.options?.expandPromptTemplates === true));
check("commands keyboard runs a pi prompt template", true);
pushMessage(CHAT, "/review src/index.ts");
await waitFor("typed command passthrough", () => userMessages.some((entry) => entry.content === "/review src/index.ts"));
check("typed extension/template commands pass through to pi", true);
pushMessage(CHAT, "/settings");
await waitFor("terminal-only notice", () => textMessages("터미널 전용").length > 0);
check("terminal-only pi commands explained instead of sent to the model", !userMessages.some((entry) => String(entry.content) === "/settings"));
pushMessage(CHAT, "/nonsense arg");
await waitFor("unknown command notice", () => textMessages("알려진 명령이 아니어서").length > 0);
check("unknown commands forwarded with a notice", userMessages.some((entry) => entry.content === "/nonsense arg"), promptText().slice(-120));

// 9. session listings and their keyboard actions
pushMessage(CHAT, "/fork");
await waitFor("fork keyboard", () => lastKeyboard("fork").length > 0);
const forkRows = lastKeyboard("fork");
check("/fork lists user prompts newest first", buttons(forkRows)[0].text.includes("second prompt"), JSON.stringify(buttons(forkRows)[0]));
pushCallback(CHAT, Number(sentMessages("fork").at(-1)?.params.message_id ?? 0), buttons(forkRows)[0].callback_data);
await waitFor("fork executed", () => sessionOps.some((op) => op.startsWith("fork:e4")));
check("fork callback forks at that prompt (pi command context)", true);
pushMessage(CHAT, "/tree");
await waitFor("tree keyboard", () => lastKeyboard("tree").length > 0);
pushCallback(CHAT, Number(sentMessages("tree").at(-1)?.params.message_id ?? 0), buttons(lastKeyboard("tree"))[1].callback_data);
await waitFor("tree navigation", () => sessionOps.some((op) => op.startsWith("navigateTree:")));
check("tree callback navigates the session tree", true);
pushMessage(CHAT, "/resume");
await waitFor("resume keyboard", () => lastKeyboard("resume").length > 0);
const resumeRows = lastKeyboard("resume");
check("/resume reads session files from disk", JSON.stringify(resumeRows).includes("parser"), JSON.stringify(resumeRows).slice(0, 200));
check("/resume sees other projects' sessions too", JSON.stringify(resumeRows).includes("deploys"), JSON.stringify(resumeRows).slice(0, 300));
check("/resume keeps this project first and tags foreign ones", buttons(resumeRows)[0].text.includes("parser") && JSON.stringify(resumeRows).includes("·other"), JSON.stringify(resumeRows).slice(0, 300));
const foreignButton = buttons(resumeRows).find((row) => row.text.includes("deploys"));
check("long session labels keep their project tag", !!foreignButton && foreignButton.text.length <= 64 && foreignButton.text.includes("·other"), JSON.stringify(foreignButton ?? ""));
pushCallback(CHAT, Number(sentMessages("resume").at(-1)?.params.message_id ?? 0), buttons(resumeRows).find((b) => b.text.includes("parser"))!.callback_data);
await waitFor("session switch", () => sessionOps.some((op) => op.startsWith("switchSession:")));
check("resume callback switches sessions", true);
pushMessage(CHAT, "/new");
await waitFor("new session", () => sessionOps.includes("newSession"));
check("/new opens a new session", true);
pushMessage(CHAT, "/skills");
await waitFor("skills keyboard", () => lastKeyboard("skills").length > 0);
check("/skills lists skill commands", JSON.stringify(lastKeyboard("skills")).includes("pdf"));

// 10. bash / export / compact / abort
pushMessage(CHAT, "/bash echo hello from tg");
await waitFor("bash executed", () => execCalls.length > 0);
check("/bash runs through pi exec", execCalls[0].args.join(" ").includes("echo hello from tg"), JSON.stringify(execCalls[0]));
await waitFor("bash output", () => textMessages("executed").length > 0);
check("/bash returns output and exit code", textMessages("✅ exit 0").length > 0);
pushMessage(CHAT, "/export");
await waitFor("export sent", () => calls.some((call) => call.method === "sendDocument"));
check("/export sends the session file", true);
idle = false;
pushMessage(CHAT, "/compact while busy");
await waitFor("compact refused while running", () => textMessages("실행 중에는 압축할 수 없어요").length > 0);
check("/compact refuses while a run is in flight", compactions.length === 0);
idle = true;
pushMessage(CHAT, "/compact keep the api details");
await waitFor("compact invoked", () => compactions.length > 0);
check("/compact passes custom instructions", JSON.stringify(compactions[0]).includes("api details"), JSON.stringify(compactions[0]));
pushMessage(CHAT, "/abort");
await waitFor("abort idle notice", () => textMessages("이미 idle").length > 0);
check("/abort is a no-op while idle", !aborted);
idle = false;
pushMessage(CHAT, "/abort");
await waitFor("abort called", () => aborted);
check("/abort aborts the run", true);
await waitFor("abort confirmed in chat", () => textMessages("중단 요청").length > 0);
check("abort confirmed in chat", true);
idle = true;

// 11. steering while running, attachments
pushMessage(CHAT, "/steer use the smaller model");
await waitFor("steer delivered", () => userMessages.some((entry) => entry.options?.deliverAs === "steer"));
check("/steer uses pi steer delivery", true);
pushMessage(CHAT, "/queue summarize after that");
await waitFor("queue delivered", () => userMessages.some((entry) => entry.options?.deliverAs === "followUp"));
check("/queue uses followUp delivery", true);
pushMessage(CHAT, "what is in this photo", { photo: [{ file_id: "photo1", width: 800, height: 600, file_size: 12 }] });
await waitFor("image delivered to pi", () => userMessages.some((entry) => Array.isArray(entry.content) && (entry.content as { type: string }[]).some((part) => part.type === "image")));
const imagePart = (userMessages.map((entry) => entry.content).filter((content) => Array.isArray(content)).flat() as { type: string; data?: string; mimeType?: string }[]).find((part) => part.type === "image");
check("photo becomes image content with real bytes", imagePart?.mimeType === "image/jpeg" && Buffer.from(imagePart?.data ?? "", "base64").length === jpegBytes.length, `${imagePart?.mimeType} ${imagePart?.data?.length}`);
pushMessage(CHAT, "read this file", { document: { file_id: "doc1", file_name: "notes.md", mime_type: "text/markdown", file_size: 30 } });
await waitFor("text document inlined", () => promptText().includes("Attached file from Telegram: notes.md"));
check("text document inlined as a prompt", promptText().includes("```"), promptText().slice(-160));
pushMessage(CHAT, "here is an archive", { document: { file_id: "bin1", file_name: "app.zip", mime_type: "application/zip", file_size: 900 } });
await waitFor("unsupported attachment notice", () => textMessages("unsupported attachment").length > 0);
check("unsupported attachment explained, not silently dropped", true);
pushMessage(CHAT, "", { voice: { file_id: "v1", file_size: 10 } });
await waitFor("voice notice", () => textMessages("voice messages are not transcribed").length > 0);
check("voice messages explained", true);

// 12. detail levels: long answers chunk, verbosity 2 mirrors thinking + results, 0 hides tools
pushMessage(CHAT, "/stream off");
await waitFor("stream off", () => textMessages("실시간 초안 off").length > 0);
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "D".repeat(9000) }] } });
await waitFor("long answer chunked", () => sentMessages("DDDD").length >= 3, 10_000);
check("long answers split into Telegram-sized chunks", sentMessages("DDDD").length >= 3, `${sentMessages("DDDD").length} chunks`);
check("chunks stay under the Telegram limit", sentMessages("DDDD").every((call) => String(call.params.text).length <= 4000));

pushMessage(CHAT, "/verbose 2");
await waitFor("detail 2", () => textMessages("detail 2").length > 0);
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me consider the options carefully." },
			{ type: "text", text: "verbose answer here" },
		],
		usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.0123 } },
		durationMs: 900,
	},
});
await waitFor("thinking mirrored", () => textMessages("consider the options").length > 0);
check("thinking mirrored at detail 2", true);
await waitFor("usage footer mirrored", () => textMessages("↑10 ↓20 tok").length > 0);
check("token/cost footer mirrored at detail 2", true);
emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls -la" } });
await waitFor("tool call mirrored", () => textMessages("ls -la").length > 0);
emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [{ type: "text", text: "total 8\ndrwxr-xr-x 2 user user 4096 Jan 1 00:00 ." }] }, isError: false, durationMs: 120 });
await waitFor("tool result mirrored", () => textMessages("drwxr-xr-x").length > 0);
check("tool output mirrored at detail 2", true);
emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t3", toolName: "read", args: { path: "nested" }, parentToolCallId: "t2" });
emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t3", toolName: "read", result: { content: [{ type: "text", text: "SECRET-NESTED-OUTPUT" }] }, isError: false, parentToolCallId: "t2" });
await sleep(300);
check("nested tool calls are not mirrored twice", !textMessages("SECRET-NESTED-OUTPUT").length);

pushMessage(CHAT, "/verbose 0");
await waitFor("detail 0", () => textMessages("detail 0").length > 0);
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "only answer arrives" }] } });
emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "t4", toolName: "grep", args: { pattern: "needle" } });
emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t4", toolName: "grep", result: { content: [{ type: "text", text: "hit" }] }, isError: false });
emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant" } });
emit("agent_end", { type: "agent_end" });
await waitFor("answer at detail 0", () => textMessages("only answer arrives").length > 0);
await sleep(400);
check("detail 0 hides tool noise", !textMessages("needle").some((call) => String(call.params.text).includes("이번 턴")) && !textMessages("hit").length);

// 13. multi-chat mirroring
const beforeBroadcast = textMessages("verbose answer here").length;
commandHandlers.get("telegram")?.(`add ${EXTRA}`, ctx);
await waitFor("third chat paired", () => readFileSync(configPath, "utf8").includes(String(EXTRA)));
check("/telegram add pairs an extra chat", true);
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `broadcast ${beforeBroadcast}` }] } });
await waitFor("mirrored to every paired chat", () => textMessages(`broadcast ${beforeBroadcast}`).length >= 3, 8000);
check("answers broadcast to all paired chats", true);

// 14. model-facing tools
const sendTool = registeredTools.find((tool) => tool.name === "telegram_send")!;
const sendResult = (await sendTool.execute("id1", { text: "pushed from pi" }, undefined, undefined, ctx)) as { content: { text: string }[] };
check("telegram_send delivers to every chat and reports it", textMessages("pushed from pi").length >= 3 && /sent to \d+ Telegram chat/.test(sendResult.content[0].text), sendResult.content[0].text);
writeFileSync(join(workDir, "report.txt"), "file payload from pi", "utf8");
await sendTool.execute("id1b", { path: "report.txt", caption: "the report" }, undefined, undefined, ctx);
await waitFor("telegram_send file", () => calls.some((call) => call.method === "sendDocument" && call.params.file_name === "report.txt"));
check("telegram_send attaches files", true);

const askTool = registeredTools.find((tool) => tool.name === "telegram_ask")!;
const askPromise = askTool.execute("id2", { question: "Which build?", options: ["debug", "release"], timeout_seconds: 60 }, undefined, undefined, ctx);
await waitFor("ask buttons", () => lastKeyboard("Which build?").length > 0);
const askRows = lastKeyboard("Which build?");
// A button answers the chat it was shown in — tapping it from another chat is refused on purpose.
const askChat = Number(sentMessages("Which build?").at(-1)?.params.chat_id ?? CHAT);
pushCallback(askChat, Number(sentMessages("Which build?").at(-1)?.params.message_id ?? 0), buttons(askRows)[1].callback_data);
const askResult = (await askPromise) as { content: { text: string }[]; details: { answered?: boolean; answer?: string } };
check("telegram_ask waits for the tapped button and returns it", askResult.content[0].text === "release" && askResult.details.answered === true, JSON.stringify(askResult));

// 15. chat administration from Telegram
pushMessage(CHAT, "/chats");
await waitFor("chats listing", () => textMessages("paired chats").length > 0);
const chatRows = lastKeyboard("paired chats");
check("chat revoke buttons offered", chatRows.flat().length >= 3, JSON.stringify(chatRows).slice(0, 200));
pushCallback(CHAT, Number(textMessages("paired chats").at(-1)?.params.message_id ?? 0), chatRows.flat().at(-1)!.callback_data);
await waitFor("chat removed from config", () => !readFileSync(configPath, "utf8").includes(String(EXTRA)));
check("revoke button removes that chat", true);
pushMessage(CHAT, "/tg pending");
await waitFor("pending listing", () => textMessages("pending").length > 0);
check("/tg pending reachable from Telegram", true);

// 16. edited messages, empty messages
pushEdited(CHAT, "i edited my message");
await waitFor("edited notice", () => textMessages("편집된 메시지").length > 0);
check("edited messages ignored with a notice", !promptText().includes("i edited my message"));
pushMessage(CHAT, "   ");
await waitFor("empty hint", () => textMessages("텍스트·이미지").length > 0);
check("empty message gets a hint instead of an empty prompt", !userMessages.some((entry) => entry.content === "   "));

// 16b. pi refuses a prompt: the chat is told, not left hanging
suppressRunStart = true;
pushMessage(CHAT, "a prompt pi will never run");
await waitFor("refused prompt explained", () => textMessages("실행되지 않았어요").length > 0, 20_000);
check("a prompt pi never starts a run for is reported, not silently dropped", true);
suppressRunStart = false;

// 17. expired keyboard button
pushMessage(CHAT, "/model");
await waitFor("fresh model list", () => sentMessages("model").filter((call) => call.params.reply_markup).length >= 2);
const stale = keyboardOf(sentMessages("model").filter((call) => call.params.reply_markup).at(-1)!).flat()[0].callback_data;
commandHandlers.get("telegram")?.("chats", ctx); // no-op side effect only
const staleMessage = Number(sentMessages("model").at(-1)?.params.message_id ?? 0);
pushCallback(CHAT, staleMessage, "t:k99999");
await waitFor("expired toast", () => calls.some((call) => call.method === "answerCallbackQuery" && String(call.params.text ?? "").includes("만료")));
check("stale/expired buttons get a toast instead of breaking", true);
await waitFor("stale keyboard emptied", () =>
	calls.some((call) => call.method === "editMessageReplyMarkup" && Number(call.params.message_id) === staleMessage && JSON.stringify((call.params.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard ?? null) === "[]"),
);
check("a stale keyboard removes its own buttons so taps cannot repeat", calls.some((call) => call.method === "editMessageReplyMarkup" && Number(call.params.message_id) === staleMessage));
void stale;

// 18. markdown -> Telegram HTML: the pi terminal look, without losing text
// Compare content ignoring all whitespace: chunk boundaries may drop spaces, tags are stripped.
const flatten = (value: string) => value.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
{
	const long = `${"word ".repeat(4000)}\n\n${"x".repeat(9000)}`;
	const chunks = toHtmlChunks(long);
	check("long answers keep every character", flatten(chunks.join("")) === flatten(long), `${chunks.length} chunks`);
	check("no chunk exceeds the Telegram message limit", chunks.every((chunk) => chunk.length <= 4096), String(Math.max(...chunks.map((chunk) => chunk.length))));
	const fenced = toHtmlChunks("```ts\n" + "y".repeat(9000) + "\n```");
	check("code fences stay balanced across chunks", fenced.every((chunk) => (chunk.match(/<pre>/g) ?? []).length === (chunk.match(/<\/pre>/g) ?? []).length), JSON.stringify(fenced.map((chunk) => chunk.length)));
	check("nested fences render literally", mdToHtml("````markdown\n```ts\ncode\n```\n````").includes("<pre><code>```ts"));
	check("markdown tables become aligned monospace", mdToHtml("| model | ctx |\n|---|---|\n| opus | 200k |").includes("<pre>model | ctx"));
	check("draft preview stays inside the draft budget", draftHtml("z".repeat(9000)).length <= 3200, String(draftHtml("z".repeat(9000)).length));
}

// 19. a failed or truncated model call must show up in the chat, with secrets redacted
{
	const before = textMessages().length;
	const seen = () =>
		textMessages()
			.slice(before)
			.map((call) => String(call.params.text ?? ""))
			.join(" | ");
	emit("message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: '403: {"message":"Key limit exceeded. Manage it using https://openrouter.ai/settings/keys?token=sk-or-v1-SECRETLIKEVALUE1234567890abcdef","code":403}',
		},
	});
	await waitFor("failed model call reported in chat", () => /❌/.test(seen()));
	check("a failed model call is reported, not swallowed", /❌/.test(seen()), seen().slice(0, 240));
	check("provider errors never put the key in the chat", !/sk-or-v1-SECRETLIKEVALUE|sk-[A-Za-z0-9_-]{12,}/.test(seen()), seen().slice(0, 240));
	check("provider errors keep urls to their host", !seen().includes("/settings/keys"), seen().slice(0, 240));

	emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a cut off answer" }], stopReason: "length" } });
	await waitFor("max-tokens cutoff warning", () => /max tokens|잘렸/.test(seen()));
	check("a max-tokens cutoff says the answer was cut", true);

	// A run that dies before any message exists (no provider key, request rejected) is only visible
	// in pi's terminal — Telegram would wait forever for an answer that is never coming.
	emit("agent_start", { type: "agent_start" });
	emit("agent_end", { type: "agent_end", messages: [{ role: "user", content: "a prompt with no reply" }] });
	await waitFor("silent run notice", () => /답 없이 실행을 끝냈어요/.test(seen()));
	check("a run that produced nothing still says so", true);
}

// 20. pi can hand us malformed listings; keyboards must survive them
{
	const keyboardsWith = (heading: string) => sentMessages(heading).filter((call) => call.params.reply_markup);
	allTools.push({ description: "tool with no name" }, undefined as never);
	piCommands.push({ description: "command with no name" }, null as never);
	models.push({ type: "chat", provider: "mock", id: "", name: "No Id Model", contextWindow: 1000 } as never, null as never);

	const toolsBefore = keyboardsWith("tools").length;
	pushMessage(CHAT, "/tools");
	await waitFor("tools keyboard after junk", () => keyboardsWith("tools").length > toolsBefore);
	const junkTools = JSON.stringify(keyboardOf(keyboardsWith("tools").at(-1)!));
	check("malformed tool entries are skipped, not fatal", junkTools.includes("read") && !junkTools.includes("no name"), junkTools.slice(0, 200));

	const commandsBefore = keyboardsWith("pi commands").length;
	pushMessage(CHAT, "/commands");
	await waitFor("commands keyboard after junk", () => keyboardsWith("pi commands").length > commandsBefore);
	const junkCommands = JSON.stringify(keyboardOf(keyboardsWith("pi commands").at(-1)!));
	check("malformed command entries are skipped", junkCommands.includes("review") && !junkCommands.includes("no name"), junkCommands.slice(0, 200));

	const modelsBefore = keyboardsWith("model").length;
	pushMessage(CHAT, "/model");
	await waitFor("model keyboard after junk", () => keyboardsWith("model").length > modelsBefore);
	const junkModels = JSON.stringify(keyboardOf(keyboardsWith("model").at(-1)!));
	check("malformed model entries are skipped", junkModels.includes("Mock Model") && !junkModels.includes("No Id Model"), junkModels.slice(0, 200));
	check("a model switch survives malformed entries", true);
	pushMessage(CHAT, "/model second-model");
	await waitFor("switch with junk present", () => ctx.model.id === "second-model", 8000);
	check("malformed registry entries never break a model switch", ctx.model.id === "second-model", ctx.model.id);
	// leave the fixtures clean for the sections that follow
	allTools.splice(allTools.length - 2, 2);
	piCommands.splice(piCommands.length - 2, 2);
	models.splice(models.length - 2, 2);
}

// 20b. models served by a local server (llama.cpp, ollama, lmstudio) are absent from pi's
//      "available" list and models.json entries have no `type` — both belong at the top of /model.
{
	const menusBefore = () => sentMessages("model").filter((call) => call.params.reply_markup).length;
	const beforeLocalModels = menusBefore();
	pushMessage(CHAT, "/model");
	await waitFor("model list including local models", () => menusBefore() > beforeLocalModels);
	const rows = buttons(lastKeyboard("model")).map((button) => button.text);
	const localIndex = rows.findIndex((text) => text.includes("llama.cpp"));
	const ollamaIndex = rows.findIndex((text) => text.includes("Qwen3 30B A3B"));
	const cloudIndex = rows.findIndex((text) => text.includes("Mock Model"));
	check("models registered in models.json show up in /model", localIndex >= 0 && ollamaIndex >= 0, rows.join(" | ").slice(0, 240));
	check("local models are listed before the cloud ones", localIndex >= 0 && localIndex < cloudIndex && ollamaIndex < cloudIndex, `local=${localIndex} ollama=${ollamaIndex} cloud=${cloudIndex}`);
	check("a local model reads as local on its button", rows[localIndex]?.includes("🏠") === true, rows[localIndex]);
	check("a model entry without a `type` is not filtered out", rows.some((text) => text.includes("No Type Model")), rows.join(" | ").slice(0, 240));
	check("a keyless cloud model is not passed off as local", !rows.some((text) => text.includes("No Credentials Cloud")), rows.join(" | ").slice(0, 240));

	pushMessage(CHAT, "/model qwen3.8");
	await waitFor("local model switched by name", () => ctx.model.id === "qwen3.8-27b", 8000);
	check("/model <name> switches straight to a local model", ctx.model.id === "qwen3.8-27b", ctx.model.id);
	pushMessage(CHAT, "/model mock-model");
	await waitFor("back to the mock model", () => ctx.model.id === "mock-model", 8000);
}

// 20h. an openrouter-sized provider: nobody pages through 400 ids, so `/model` drills down to
//      providers, a typed provider/id resolves against the whole registry, and an id pi has never
//      seen is still usable by borrowing the provider's own shape.
{
	const shapeOf = (provider: string, index: number): FakeModel => ({
		type: "chat",
		provider,
		id: `bulk-model-${index}`,
		name: `Bulk Model ${index}`,
		baseUrl: "https://bulk.example/v1",
		contextWindow: 128_000,
		reasoning: false,
	});
	// 1. a registry far bigger than the usable list has to be mentioned, or nobody discovers they can type
	const hidden = Array.from({ length: 20 }, (_unused, index) => shapeOf("bulkprov", index));
	extraModels.push(...hidden);
	const curatedBefore = sentMessages("available").filter((call) => call.params.reply_markup).length;
	pushMessage(CHAT, "/model");
	await waitFor("model list mentioning the wider registry", () => sentMessages("available").filter((call) => call.params.reply_markup).length > curatedBefore);
	const curatedNote = String(sentMessages("available").filter((call) => call.params.reply_markup).at(-1)?.params.text ?? "");
	check("a much wider registry is announced, pointing at typed references", curatedNote.includes("pi가 아는 모델은") && curatedNote.includes("provider/id"), curatedNote.slice(0, 160));

	// 2. once the usable list itself is huge, `/model` drills down to providers instead of paging
	const bulk = Array.from({ length: 45 }, (_unused, index) => shapeOf("bulkprov", index + 100));
	extraModels.push(...bulk);
	const bulkStart = models.length;
	models.push(...bulk);

	pushMessage(CHAT, "/model");
	await waitFor("provider drill-down for a big list", () => sentMessages("provider를 고르세요").some((call) => call.params.reply_markup));
	const drill = sentMessages("provider를 고르세요").filter((call) => call.params.reply_markup).at(-1)!;
	const providerRows = buttons(keyboardOf(drill));
	check(
		"/model asks which provider when the list is too big to page",
		providerRows.some((row) => row.text.includes("bulkprov · 65개")),
		providerRows.slice(0, 3).map((row) => row.text).join(" | "),
	);
	check("the drill-down keeps individual models out of the way", !JSON.stringify(providerRows).includes("Bulk Model"), providerRows[0]?.text);

	pushCallback(CHAT, Number(drill.params.message_id), providerRows.find((row) => row.text.includes("bulkprov"))!.callback_data);
	await waitFor("bulkprov models listed", () => lastKeyboard('"bulkprov"').length > 0);
	const bulkRows = buttons(lastKeyboard('"bulkprov"')).filter((row) => row.text.includes("Bulk Model"));
	check("a provider filter lists that provider's models", bulkRows.length > 10 && bulkRows.every((row) => row.text.includes("bulkprov")), bulkRows.slice(0, 2).map((row) => row.text).join(" | "));
	check("a provider pi has no credentials for is marked 🔑", bulkRows.every((row) => row.text.includes("🔑")), bulkRows[0]?.text);

	pushMessage(CHAT, "/model bulkprov/bulk-model-7");
	await waitFor("typed provider/id switches", () => ctx.model.id === "bulk-model-7", 8000);
	check("a model pi keeps out of its available list is still selectable by id", ctx.model.baseUrl === "https://bulk.example/v1", JSON.stringify(ctx.model));

	pushMessage(CHAT, "/model bulkprov/a-model-nobody-registered");
	await waitFor("unregistered id switches", () => ctx.model.id === "a-model-nobody-registered", 8000);
	check("an id pi has never seen borrows the provider's shape", ctx.model.baseUrl === "https://bulk.example/v1" && ctx.model.contextWindow === 128_000, JSON.stringify(ctx.model));
	await waitFor("the chat explains the unknown id", () => textMessages("pi가 처음 보는 id예요").length > 0, 8000);
	check("the chat learns the id was not in pi's registry", true, String(textMessages("model →").at(-1)?.params.text ?? ""));

	pushMessage(CHAT, "/model nosuchprovider/foo");
	await waitFor("unknown provider explained", () => textMessages("provider를 모르겠어요").length > 0, 8000);
	check("an unknown provider is explained instead of guessed", true);

	extraModels.length = 0;
	models.splice(bulkStart, bulk.length);
	await sleep(200);
}

// 20i. aggregator ids are typed the way the provider writes them. In `nvidia/nemotron-3.5-super-vl:free`
// there is no "nvidia" provider in pi at all — the manufacturer lives *inside* the openrouter model id.
{
	const orModels: FakeModel[] = [
		{ type: "chat", provider: "openrouter", id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 131_072, reasoning: false },
		{ type: "chat", provider: "openrouter", id: "nvidia/nemotron-3.5-super-vl", name: "Nemotron 3.5 Super", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 131_072, reasoning: false },
		{ type: "chat", provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 200_000, reasoning: true },
	];
	extraModels.push(...orModels);
	pushMessage(CHAT, "/model nvidia/nemotron-3.5-super-vl:free");
	await waitFor("aggregator id resolves to its provider", () => ctx.model.id === "nvidia/nemotron-3.5-super-vl:free" && ctx.model.provider === "openrouter", 8000);
	const resolved = lastTextFor(CHAT);
	check("an openrouter-style id is applied directly, not searched", resolved.includes("🔀 model →") && resolved.includes("openrouter/nvidia/nemotron-3.5-super-vl:free"), resolved.slice(0, 140));
	check("the bridge says how it read the typed id", resolved.includes("해석했어요"), resolved.slice(0, 160));
	// an id nobody has registered yet borrows the shape of a sibling model from the same family
	pushMessage(CHAT, "/model nvidia/nemotron-9.9-brand-new:free");
	await waitFor("unknown aggregator id clones the provider shape", () => ctx.model.id === "nvidia/nemotron-9.9-brand-new:free" && ctx.model.provider === "openrouter", 8000);
	const cloned = lastTextFor(CHAT);
	check("a brand new aggregator id is accepted with the borrowed shape", cloned.includes("✨") && cloned.includes("nvidia/nemotron-3.5-super-vl:free"), cloned.slice(0, 200));
	extraModels.length = 0;
	pushMessage(CHAT, "/model mock-model");
	await waitFor("back to the default model", () => ctx.model.name === "Mock Model", 8000);
	await sleep(200);
}

// 21. /new, /resume and /fork dispose the pi session and re-create the extension:
//     the action's confirmation has to reach the bridge instance that comes back up.
{
	const stoppedBefore = textMessages("bridge stopped").length;
	const originalNewSession = ctx.newSession;
	ctx.newSession = async () => {
		sessionOps.push("newSession:replace");
		await emitAwait("session_shutdown", { type: "session_shutdown", reason: "new" });
		await emitAwait("session_start", { type: "session_start", reason: "new" });
	};
	pushMessage(CHAT, "/new");
	await waitFor("new session ran through the replacing path", () => sessionOps.includes("newSession:replace"), 15_000);
	const noticeText = "새 세션</b>이 열렸어요";
	await waitFor("restart notice delivered by the reconnected bridge", () => textMessages(noticeText).length > 0, 15_000);
	check("confirmation survives the session replacement", textMessages(noticeText).length > 0, lastTextFor(CHAT).slice(0, 160));
	check("a replacement does not announce a stopped bridge", textMessages("bridge stopped").length === stoppedBefore, lastTextFor(CHAT).slice(0, 160));
	await waitFor("notice cleared from config", () => !readFileSync(configPath, "utf8").includes("pendingNotice"), 5000);
	check("queued notice is consumed once", true);
	ctx.newSession = originalNewSession;
}

// 20c. an answer already on screen stays in the chat when the next turn starts
emit("agent_start", { type: "agent_start" });
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
await waitFor("history draft created", () => calls.some((call) => call.method === "sendMessage" && String(call.params.text ?? "").includes("생각 중")));
emit("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "history 첫 답변" }] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "history 첫 답변" }] } });
await waitFor("history first answer", () => sentMessages("history 첫 답변").length > 0);
const delivered = [...calls].reverse().find((call) => String(call.params.text ?? "").includes("history 첫 답변"));
const deliveredId = delivered?.id;
const deliveredIndex = delivered ? calls.indexOf(delivered) : -1;
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "history 둘째 답변" }] } });
await waitFor("history second answer", () => sentMessages("history 둘째 답변").length > 0);
const disturbed = calls
	.slice(deliveredIndex + 1)
	.filter((call) => (call.method === "deleteMessage" || call.method === "editMessageText") && Number(call.params.message_id) === deliveredId);
check("a delivered answer is never deleted or rewritten by the next turn", deliveredId !== undefined && disturbed.length === 0, `id=${deliveredId} disturbed=${disturbed.length}`);
check("the next turn writes into a fresh message", calls.slice(deliveredIndex + 1).some((call) => call.method === "sendMessage" && String(call.params.text ?? "").includes("history 둘째 답변")));

// 20d. while pi works telegram shows "입력 중…", and stops when the run ends
emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "history 끝" }], stopReason: "stop" }] });
emit("agent_settled", { type: "agent_settled", aborted: false });
await sleep(5200); // let the hint cycle drain so the next assertion measures a fresh run
const typingBefore = calls.filter((call) => call.method === "sendChatAction").length;
emit("agent_start", { type: "agent_start" });
const typingShown = await waitFor("typing hint while working", () => calls.filter((call) => call.method === "sendChatAction").length > typingBefore, 2500).then(
	() => true,
	() => false,
);
check("a run in flight shows 입력 중…", typingShown);
const pulsesWhileRunning = calls.filter((call) => call.method === "sendChatAction").length;
emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "history 끝" }], stopReason: "stop" }] });
emit("agent_settled", { type: "agent_settled", aborted: false });
await sleep(5200);
check("the typing hint stops once the run ends", calls.filter((call) => call.method === "sendChatAction").length === pulsesWhileRunning);

// 20e. /tg stats tells pi-side waiting from telegram-side latency
pushMessage(CHAT, "/tg stats");
await waitFor("stats reply", () => textMessages("지연 통계").length > 0);
check("/tg stats reports latency bookkeeping", true);

// 20f. the "/" menu must be registered where telegram actually serves it, and a foreign menu is caught
check(
	"the menu is registered for private chats too, not only the default scope",
	calls.some((call) => call.method === "setMyCommands" && (call.params.scope as { type?: string } | undefined)?.type === "all_private_chats"),
	calls.filter((call) => call.method === "setMyCommands").map((call) => JSON.stringify(call.params.scope ?? null)).join(" "),
);
pushMessage(CHAT, "/tg menu");
await waitFor("menu confirmation", () => sentMessages("자동완성 메뉴 등록 완료").length > 0);
check("/tg menu re-registers and reads the menu back", true);
shadowMenu = true;
pushMessage(CHAT, "/tg menu");
await waitFor("shadowed menu warning", () => sentMessages("우리 명령이 목록에 없어요").length > 0);
check("a menu overwritten by another program on the same token is called out", true);
shadowMenu = false;

// 20g. pi rejects prompts while it compacts, so the bridge parks them and replays them afterwards
emit("session_before_compact", { type: "session_before_compact", preparation: {}, reason: "manual", willRetry: false });
const compactNotice = await waitFor("compacting notice", () => sentMessages("컨텍스트 압축 중").length > 0, 5000).then(
	() => sentMessages("컨텍스트 압축 중")[0],
	() => undefined,
);
check("the chat is told pi is rebuilding its context", Boolean(compactNotice), "no 🗜 notice");
check("the compaction notice says what triggered it and how big the context is", /42\.0k tokens/.test(String(compactNotice?.params.text ?? "")) && String(compactNotice?.params.text ?? "").includes("/compact로 시작"), shapeText(String(compactNotice?.params.text ?? "")));
const promptsBeforeCompaction = userMessages.length;
pushMessage(CHAT, "압축 중에 보낸 메시지");
await waitFor("held message notice", () => sentMessages("컨텍스트를 압축/요약 중").length > 0);
check("a prompt sent during compaction is never thrown at pi", userMessages.length === promptsBeforeCompaction, `+${userMessages.length - promptsBeforeCompaction}`);
emit("session_compact", { type: "session_compact", compactionEntry: { tokensBefore: 45_000 }, reason: "manual", willRetry: false });
const compactDone = await waitFor("compaction done notice", () => sentMessages("컨텍스트 압축 완료").length > 0, 5000).then(
	() => sentMessages("컨텍스트 압축 완료")[0],
	() => undefined,
);
check("the chat learns the compaction finished and how much it saved", String(compactDone?.params.text ?? "").includes("45.0k → 42.0k"), shapeText(String(compactDone?.params.text ?? "")));
await waitFor("held prompt delivered after compaction", () => userMessages.length > promptsBeforeCompaction, 8000);
check("the parked prompt reaches pi once compaction finishes", userMessages.length > promptsBeforeCompaction);
await waitFor("flush notice", () => sentMessages("압축 끝 — 기다리던 메시지").length > 0);
check("the chat learns that the parked message was delivered", true);
emit("session_before_compact", { type: "session_before_compact", preparation: {}, reason: "threshold", willRetry: true });
emit("session_compact_failed", { type: "session_compact_failed", reason: "threshold", errorMessage: "provider said no", aborted: false, willRetry: true });
const compactFailed = await waitFor("compaction failure notice", () => sentMessages("컨텍스트 압축 실패").length > 0, 5000).then(
	() => sentMessages("컨텍스트 압축 실패")[0],
	() => undefined,
);
check("a failed compaction is reported, not left silent", String(compactFailed?.params.text ?? "").includes("provider said no") && String(compactFailed?.params.text ?? "").includes("컨텍스트 임계값"), shapeText(String(compactFailed?.params.text ?? "")));
const promptsAfterFailedCompaction = userMessages.length;
pushMessage(CHAT, "압축 실패 후에도 보내지는 메시지");
await waitFor("prompt after failed compaction", () => userMessages.length > promptsAfterFailedCompaction, 8000);
check("a failed compaction does not leave the bridge holding prompts forever", userMessages.length > promptsAfterFailedCompaction);

// 21a. an idle long poll must never hold up an answer: polling and sending are separate lanes
const releaseHeldPoll = holdNextPoll();
await sleep(120); // let the bridge's poll settle into the gate
const pollProbeBefore = sentMessages("poll-probe").length;
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "poll-probe answer" }] } });
const sentDuringPoll = await waitFor("answer while the poll is parked", () => sentMessages("poll-probe").length > pollProbeBefore, 2000).then(
	() => true,
	() => false,
);
releaseHeldPoll();
check("an idle long poll never delays an answer", sentDuringPoll, "the send queued behind getUpdates");

// 21b. nothing we sent breaks telegram's own keyboard limits
const oversizedButtons = calls
	.filter((call) => call.params.reply_markup)
	.flatMap((call) => ((call.params.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })?.inline_keyboard ?? []).flat())
	.filter((button) => button.text.length > 64 || new TextEncoder().encode(button.callback_data ?? "").byteLength > 64);
check("no keyboard button exceeds telegram's own limits", oversizedButtons.length === 0, JSON.stringify(oversizedButtons[0] ?? {}).slice(0, 160));

// 21c. security: credentials, floods, stolen keyboards, untrusted input
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
check("the bridge knows its own token is a secret", BOT_TOKEN.length > 0);
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `my bot token is ${BOT_TOKEN} — keep it safe` }] } });
await waitFor("token-bearing answer mirrored", () => sentMessages("my bot token is").length > 0, 8000);
check(
	"our own token never reaches a chat, even when pi prints it",
	!calls.some((call) => JSON.stringify(call.params).includes(BOT_TOKEN)),
	JSON.stringify(calls.find((call) => JSON.stringify(call.params).includes(BOT_TOKEN))?.params ?? "").slice(0, 120),
);

// the live draft is a different path out of the bridge, so prove it is scrubbed as well
pushMessage(CHAT, "/stream on");
await waitFor("drafts back on", () => textMessages("실시간 초안 on").some((call) => Number(call.params.chat_id) === CHAT), 8000);
idle = false;
emit("agent_start", { type: "agent_start" });
emit("turn_start", { type: "turn_start", turnIndex: 0 });
emit("message_start", { type: "message_start", message: { role: "assistant", content: [] } });
emit("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `streaming token ${BOT_TOKEN}` }] } });
await waitFor("draft shows the answer", () => calls.some((call) => (call.method === "editMessageText" || call.method === "sendMessage") && String(call.params.text).includes("streaming token")), 12_000);
check("a live streaming draft never carries our token either", !calls.some((call) => JSON.stringify(call.params).includes(BOT_TOKEN)));
const streamed = `streaming token ${BOT_TOKEN}`;
emit("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: streamed }] } });
emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [{ type: "text", text: streamed }] }, toolResults: [] });
emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: streamed }] }] });
emit("agent_settled", { type: "agent_settled", aborted: false });
idle = true;
await sleep(300);
pushMessage(CHAT, "/stream off");
await waitFor("drafts back off", () => textMessages("실시간 초안 off").some((call) => Number(call.params.chat_id) === CHAT), 8000);

pushMessage(CHAT, "x".repeat(13_000));
await waitFor("oversized message refused", () => textMessages("지나치게 긴 메시지").length > 0, 8000);
check("an oversized prompt is refused rather than dumped into pi", !userMessages.some((entry) => String(entry.content).includes("x".repeat(200))));

pushMessage(CHAT, "huge file", { document: { file_id: "big1", file_name: "huge.bin", mime_type: "application/octet-stream", file_size: 40 * 1024 * 1024 } });
await waitFor("oversized attachment refused", () => textMessages("파일이 너무 커요").length > 0, 8000);
check("an oversized attachment is never downloaded", !calls.some((call) => call.method === "getFile" && call.params.file_id === "big1"));

const SPAM = 555000777;
for (let i = 0; i < 24; i += 1) pushMessage(SPAM, `spam ${i}`);
await sleep(600);
const spamReplies = textMessages().filter((call) => Number(call.params.chat_id) === SPAM).length;
check("a stranger flooding the bot is cut off", spamReplies > 0 && spamReplies <= UNPAIRED_ALLOWANCE, `${spamReplies} replies to 24 messages`);

const promptFloor = userMessages.length;
for (let i = 0; i < 120; i += 1) pushMessage(CHAT, `flood ${i}`);
await waitFor("flooding chat throttled", () => textMessages("너무 빨라요").some((call) => Number(call.params.chat_id) === CHAT), 12_000);
const floodDelivered = userMessages.slice(promptFloor).filter((entry) => String(entry.content).includes("flood ")).length;
check("a flooding chat cannot outrun the bot's send quota", floodDelivered > 0 && floodDelivered <= PAIRED_ALLOWANCE && floodDelivered < 120, `${floodDelivered} of 120 reached pi`);

pushMessage(CHAT, "/thinking");
await waitFor("thinking keyboard", () => buttons(lastKeyboard("thinking")).length > 0, 8000);
const borrowed = buttons(lastKeyboard("thinking")).find((button) => (button.callback_data ?? "").startsWith("t:"));
const THIEF = 555000999;
const thinkingBefore = thinkingLevel;
commandHandlers.get("telegram")?.(`add ${THIEF}`, ctx);
await sleep(150);
pushCallback(THIEF, 4242, borrowed?.callback_data ?? "t:none");
await waitFor("cross-chat keyboard tap refused", () => calls.some((call) => call.method === "answerCallbackQuery" && String(call.params.text).includes("다른 채팅")), 8000);
check("a keyboard tap from another chat is refused", true);
check("the borrowed tap did not act on pi", thinkingLevel === thinkingBefore, `thinkingLevel ${thinkingBefore} -> ${thinkingLevel}`);

const savedRoot = process.env.TELEGRAM_API_ROOT;
process.env.TELEGRAM_API_ROOT = "http://telegram-mirror.example.com";
let refused = "";
try {
	new TelegramBot(BOT_TOKEN).apiRoot;
} catch (error) {
	refused = error instanceof Error ? error.message : String(error);
}
process.env.TELEGRAM_API_ROOT = savedRoot;
check("TELEGRAM_API_ROOT cannot point at a plain-http third-party host", /must be https/.test(refused), refused.slice(0, 140));

if (process.platform !== "win32") {
	const mode = statSync(configPath).mode;
	check("the file holding the bot token is owner-only", (mode & 0o077) === 0, `mode=${(mode & 0o777).toString(8)}`);
} else {
	console.log("  --   file mode check skipped (windows uses ACLs, not mode bits)");
}
const tokenSamples = calls
	.flatMap((call) => ((call.params.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat())
	.map((button) => (button.callback_data ?? "").slice(2))
	.filter((value) => value.length >= 8);

// 22. shutdown persists config
emit("session_shutdown", { reason: "quit" });
await sleep(200);
const saved = JSON.parse(readFileSync(configPath, "utf8")) as { offset?: number; chats: unknown[]; verbosity?: number };
check("config persists chats, verbosity and update offset", saved.offset !== undefined && Array.isArray(saved.chats) && saved.verbosity === 0, JSON.stringify(saved).slice(0, 200));
check("the config write leaves no temp copy of the token behind", !existsSync(`${configPath}.tmp`));
const leakedTokens = tokenSamples.filter((token) => token && readFileSync(configPath, "utf8").includes(token));
check("no keyboard tokens leak into config", leakedTokens.length === 0, `${tokenSamples.length} sampled, leaked: ${leakedTokens.slice(0, 2).join(",")}`);

server.close();
console.log(`\n${checks - failures}/${checks} checks passed · ${calls.length} Telegram API calls`);
if (failures) {
	console.log("FAILED");
	process.exitCode = 1;
}
process.exit(failures ? 1 : 0);

/** The text of the last message the bridge sent to this chat. */
function lastTextFor(chatId: number): string {
	const list = textMessages().filter((call) => Number(call.params.chat_id) === chatId);
	return String(list.at(-1)?.params.text ?? "");
}
