/**
 * Read-only session listing for /resume, /fork, /tree.
 * Pi owns sessions; the bridge only reads the JSONL files it finds in the session directory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionSummary {
	path: string;
	id: string;
	name?: string;
	cwd?: string;
	createdAt?: string;
	modifiedAt: number;
	firstPrompt?: string;
	lastPrompt?: string;
	entryCount: number;
}

interface RawEntry {
	type?: string;
	id?: string;
	timestamp?: string;
	name?: string;
	cwd?: string;
	parentSession?: string;
	message?: { role?: string; content?: unknown };
}

const MAX_SCAN_BYTES = 200_000;
const MAX_FILES_TO_STAT = 600;

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	for (const block of content as { type?: string; text?: string }[]) {
		if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim();
	}
	return "";
}

export function summarizeSessionFile(path: string): SessionSummary | undefined {
	let handle: number | undefined;
	try {
		const stat = statSync(path);
		const fd = readFileSync(path);
		const slice = fd.subarray(0, MAX_SCAN_BYTES).toString("utf8");
		const lines = slice.split("\n");
		let summary: SessionSummary | undefined;
		let firstPrompt: string | undefined;
		let lastPrompt: string | undefined;
		let name: string | undefined;
		let entryCount = 0;
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: RawEntry;
			try {
				entry = JSON.parse(line) as RawEntry;
			} catch {
				continue;
			}
			if (entry.type === "session") {
				summary = {
					path,
					id: entry.id ?? "",
					cwd: entry.cwd,
					createdAt: entry.timestamp,
					modifiedAt: stat.mtimeMs,
					entryCount: 0,
				};
				continue;
			}
			if (!summary) continue;
			entryCount += 1;
			if (entry.type === "session_info" && entry.name) name = entry.name;
			if (entry.message?.role === "user") {
				const text = extractText(entry.message.content);
				if (text) {
					if (!firstPrompt) firstPrompt = text;
					lastPrompt = text;
				}
			}
		}
		if (!summary) return undefined;
		summary.name = name;
		summary.firstPrompt = firstPrompt;
		summary.lastPrompt = lastPrompt;
		summary.entryCount = entryCount;
		return summary;
	} catch {
		void handle;
		return undefined;
	}
}

/**
 * Newest sessions, newest first. pi keeps sessions per project (`sessions/--C--repo--/x.jsonl`),
 * so the scan walks one level of project folders too: a Telegram user wants "my recent sessions",
 * not just this project's. Files are dated first and only the newest ones are parsed.
 */
export function listSessions(dir: string, options: { limit?: number; currentId?: string } = {}): SessionSummary[] {
	if (!existsSync(dir)) return [];
	const limit = options.limit ?? 50;
	const files: string[] = [];
	const walk = (current: string, depth: number): void => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_FILES_TO_STAT) return;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (depth < 1) walk(path, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	};
	walk(dir, 0);

	const dated: { path: string; modifiedAt: number }[] = [];
	for (const path of files) {
		try {
			dated.push({ path, modifiedAt: statSync(path).mtimeMs });
		} catch {
			continue;
		}
	}
	dated.sort((a, b) => b.modifiedAt - a.modifiedAt);

	const summaries: SessionSummary[] = [];
	for (const entry of dated) {
		const summary = summarizeSessionFile(entry.path);
		if (summary) summaries.push(summary);
		if (summaries.length >= limit * 2) break;
	}
	if (options.currentId) {
		const current = summaries.findIndex((summary) => summary.id === options.currentId);
		if (current > 0) summaries.unshift(...summaries.splice(current, 1));
	}
	return summaries.slice(0, limit);
}

export interface PromptEntry {
	entryId: string;
	text: string;
	timestamp: string;
}

/** User prompts of the current session, newest first; used by /fork. */
export function listPromptEntries(entries: { id: string; type: string; timestamp: string; message?: unknown }[], limit = 25): PromptEntry[] {
	const prompts: PromptEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown } | undefined;
		if (!message || message.role !== "user") continue;
		const text = extractText(message.content);
		if (!text) continue;
		prompts.push({ entryId: entry.id, text, timestamp: entry.timestamp });
	}
	return prompts.reverse().slice(0, limit);
}
