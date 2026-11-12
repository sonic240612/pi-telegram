/**
 * Focused probe: what happens when a Telegram keyboard tap asks pi to replace the session
 * (resume / fork / new), and when it only moves the tree cursor (tree)?
 *
 *   PI_TG_DEBUG=1 node --experimental-strip-types scripts/debug-session-ops.ts "<session .jsonl>"
 *
 * Pick taps with PI_TG_PROBE_CMDS="/tree,/fork". Titles and prompts are masked in the output
 * (PI_TG_DEBUG_MASK=0 shows them) because this probe runs against a real session.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHAT = 555000111;
const TOKEN = "123456:LOCAL-PROBE-TOKEN";
const srcAgent = join(process.env.HOME ?? "", ".pi", "agent");
const sessionToOpen = process.argv[2];
const mask = process.env.PI_TG_DEBUG_MASK !== "0";

/** Keep a message's shape but hide its words: session titles and prompts belong to the user. */
function hide(value: string): string {
	return mask ? value.replace(/\p{L}+/gu, "·").replace(/\s+/g, " ") : value;
}

const agentDir = mkdtempSync(join(tmpdir(), "ptg-probe-agent-"));
const workDir = mkdtempSync(join(tmpdir(), "ptg-probe-work-"));
for (const file of ["auth.json", "models.json", "models-store.json", "settings.json", "trust.json"]) {
	const from = join(srcAgent, file);
	if (existsSync(from)) copyFileSync(from, join(agentDir, file));
}
const sessionDir = join(agentDir, "sessions", "probe");
mkdirSync(sessionDir, { recursive: true });
let copiedSession: string | undefined;
if (sessionToOpen && existsSync(sessionToOpen)) {
	copiedSession = join(sessionDir, "opened.jsonl");
	copyFileSync(sessionToOpen, copiedSession);
}
writeFileSync(join(agentDir, "telegram.json"), JSON.stringify({ token: TOKEN, chats: [{ chatId: CHAT, label: "probe" }], verbosity: 1, streaming: false }), "utf8");

const calls: { method: string; params: Record<string, unknown> }[] = [];
let updates: Record<string, unknown>[] = [];
let uid = 0;
let mid = 0;
const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const method = url.pathname.split("/").pop() ?? "";
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		let params: Record<string, unknown> = {};
		try {
			params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			/* ignore */
		}
		calls.push({ method, params });
		const json = (result: unknown) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, result }));
		};
		if (method === "getMe") return json({ id: 77, is_bot: true, first_name: "PiBridge", username: "pi_bridge_probe_bot" });
		if (method === "getUpdates") {
			const drained = updates;
			updates = [];
			return json(drained);
		}
		if (method === "sendMessage") return json({ message_id: ++mid, chat: { id: Number(params.chat_id ?? 0), type: "private" }, date: 0, text: params.text });
		if (method === "editMessageText") return json({ message_id: Number(params.message_id ?? ++mid), chat: { id: Number(params.chat_id ?? 0), type: "private" }, date: 0, text: params.text });
		if (method === "answerCallbackQuery") return json(true);
		if (method === "editMessageReplyMarkup") return json(true);
		if (method === "sendChatAction") return json(true);
		return json(true);
	});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const apiRoot = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const piCli = join(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))), "dist", "bundle", "cli.js");
const args = ["--mode", "rpc", "--offline", "--no-extensions", "-e", join(process.cwd(), "index.ts")];
if (copiedSession) args.push("--session", copiedSession);
else args.push("--no-session");
const child = spawn(process.execPath, [piCli, ...args], {
	cwd: workDir,
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TELEGRAM_API_ROOT: apiRoot, PI_OFFLINE: "1" },
	stdio: ["pipe", "pipe", "pipe"],
});
const events: string[] = [];
let pendingIn = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c: string) => events.push(`STDERR ${c.trim().slice(0, 300)}`));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	pendingIn += chunk;
	const parts = pendingIn.split("\n");
	pendingIn = parts.pop() ?? "";
	for (const line of parts.filter((l) => l.trim())) {
		let record: { type?: string; command?: string; event?: string; success?: boolean; error?: string };
		try {
			record = JSON.parse(line);
		} catch {
			events.push(`RAW ${line.slice(0, 150)}`);
			continue;
		}
		events.push(`${record.type}:${record.command ?? record.event ?? ""}${record.success === false ? ` ERR ${String(record.error).slice(0, 200)}` : ""}`);
	}
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function send(text: string): void {
	updates.push({ update_id: ++uid, message: { message_id: ++mid, from: { id: 900, first_name: "Probe" }, chat: { id: CHAT, type: "private" }, date: 0, text } });
}
function tap(messageId: number, data: string): void {
	updates.push({ update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: 900, first_name: "Probe" }, message: { message_id: messageId, chat: { id: CHAT, type: "private" }, date: 0 }, data } });
}
function texts(): string[] {
	return calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text ?? "").replace(/\s+/g, " "));
}
function keyboardFor(needle: string): { buttons: { text: string; callback_data: string }[]; messageId: number } {
	const withKb = calls.filter((c) => c.method === "sendMessage" && String(c.params.text ?? "").includes(needle) && c.params.reply_markup);
	const last = withKb.at(-1);
	const rows = (last?.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
	return { buttons: rows.flat(), messageId: Number(last?.params.message_id ?? 0) };
}
function methodCounts(): string {
	const counts = new Map<string, number>();
	for (const c of calls) counts.set(c.method, (counts.get(c.method) ?? 0) + 1);
	return JSON.stringify(Object.fromEntries([...counts].filter(([m]) => m !== "getUpdates")));
}
function since(index: number): string[] {
	return texts().slice(index);
}

console.log(`opening: ${copiedSession ?? "(fresh ephemeral session)"}`);
await sleep(6000);

const probeCommands = (process.env.PI_TG_PROBE_CMDS ?? "/resume,/fork,/tree,/new").split(",").map((entry) => entry.trim()).filter(Boolean);
for (const command of probeCommands) {
	const beforeTexts = texts().length;
	send(command);
	await sleep(2500);
	const kb = keyboardFor(command === "/resume" ? "resume" : command === "/fork" ? "fork" : command === "/tree" ? "tree" : "detail");
	const label = hide(kb.buttons[0]?.text.slice(0, 40) ?? "");
	const eventsBefore = events.length;
	const callsBefore = calls.length;
	if (kb.buttons[0]) tap(kb.messageId, kb.buttons[0].callback_data);
	await sleep(12000);
	console.log(`\n### ${command}${label ? ` → tapped "${label.slice(0, 30)}"` : " (no button)"}`);
	console.log(`  new replies: ${JSON.stringify(since(beforeTexts).map((t) => hide(t).slice(0, 90)))}`);
	console.log(`  tg calls:    ${JSON.stringify(calls.slice(callsBefore).map((c) => `${c.method}:${hide(String(c.params.text ?? "")).slice(0, 60)}`).filter((entry) => !entry.startsWith("getUpdates"))).slice(0, 700)}`);
	console.log(`  pi events:   ${JSON.stringify(events.slice(eventsBefore).slice(0, 20))}`);
	console.log(`  pi alive:    exit=${String(child.exitCode)} killed=${child.killed} signals=${events.length}`);
	console.log(`  methods:     ${methodCounts()}`);
	const pingBefore = texts().length;
	send("/ping");
	await sleep(3000);
	console.log(`  after /ping: ${JSON.stringify(since(pingBefore).map((t) => hide(t).slice(0, 70)))}`);
}

child.kill();
server.close();
console.log("\nstderr lines:");
for (const line of events.filter((e) => e.startsWith("STDERR"))) console.log(`  ${line.slice(0, 200)}`);
process.exit(0);
