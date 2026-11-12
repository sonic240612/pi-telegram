/**
 * Pi content -> Telegram HTML.
 * Telegram has no markdown; it has a small HTML dialect (<b>, <i>, <s>, <a>, <code>, <pre>, <blockquote>).
 * So we convert Markdown to that dialect, escape everything else, and split into <=4096 char messages
 * without ever cutting a code fence in half.
 */

export interface ContentBlockLike {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	id?: string;
	data?: string;
	mimeType?: string;
}

const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Opt-in diagnostics for real-pi debugging (`PI_TG_DEBUG=1`).
 * stderr only — pi shows it in the debug log, never in a chat.
 */
export function tgDebug(...parts: unknown[]): void {
	if (process.env.PI_TG_DEBUG !== "1") return;
	console.error("[pi-telegram]", ...parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))));
}
/** Leave headroom for the wrapper HTML we add around chunks. */
export const CHUNK_LIMIT = 3600;

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inlineCode(text: string): string {
	return `<code>${escapeHtml(text)}</code>`;
}

/** Convert one Markdown line (no fences) to Telegram HTML. */
function inlineToHtml(line: string): string {
	let text = line;
	const codeSpans: string[] = [];
	// Protect `code spans` first so emphasis rules cannot mangle them.
	text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
		codeSpans.push(inlineCode(code));
		return `\u0000C${codeSpans.length - 1}\u0000`;
	});
	text = escapeHtml(text);
	const links: string[] = [];
	text = text.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
		links.push(`<a href="${url}">${label || url}</a>`);
		return `\u0000L${links.length - 1}\u0000`;
	});
	text = text.replace(/(^|[\s(])((https?:\/\/)[^\s<)]+[^\s<).,;!?])/g, (_m, prefix: string, url: string) => {
		links.push(`<a href="${url}">${url}</a>`);
		return `${prefix}\u0000L${links.length - 1}\u0000`;
	});
	text = text
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|[^\w])__([^_\n]+)__(?![\w])/g, "$1<b>$2</b>")
		.replace(/(^|[\s([{*_])\*([^*\n]+)\*(?![\w*])/g, "$1<i>$2</i>")
		.replace(/(^|[^\w_])_([^_\n\n]+)_(?![\w_])/g, "$1<i>$2</i>")
		.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
	// Headings become bold labels.
	text = text.replace(/^\s{0,3}(#{1,6})\s+(.*)$/, (_m, _hashes: string, body: string) => `<b>${body}</b>`);
	// Bullet glyphs render better than a bare dash.
	text = text.replace(/^(\s*)[-*]\s+/, "$1\u2022 ");
	text = text.replace(/\u0000L(\d+)\u0000/g, (_m, index: string) => links[Number(index)] ?? "");
	text = text.replace(/\u0000C(\d+)\u0000/g, (_m, index: string) => codeSpans[Number(index)] ?? "");
	// Blockquote lines.
	if (/^&gt;\s?/.test(text)) text = `<blockquote>${text.replace(/^&gt;\s?/, "")}</blockquote>`;
	return text;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** A fence closes only on a line of the same marker char, at least as long as the opener. */
function isFenceEnd(line: string, marker: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < marker.length) return false;
	const runs = /^(`+|~+)$/.exec(trimmed);
	return Boolean(runs && runs[1][0] === marker[0] && runs[1].length >= marker.length);
}

/** A GitHub-style table renders as a monospace block — Telegram has no tables. */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isTableRow(line: string): boolean {
	return /^\s*\|.*\|\s*$/.test(line);
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replace(/\\\|/g, "|").replace(/`/g, "").trim());
}

/** Render lines[start] .. (table end) as a padded <pre> block; returns the next index. */
function renderTable(lines: string[], start: number): { html: string; next: number } | undefined {
	if (!isTableRow(lines[start]) || !TABLE_SEP_RE.test(lines[start + 1] ?? "")) return undefined;
	const rows: string[][] = [tableCells(lines[start])];
	const aligns: ("left" | "right" | "center")[] = tableCells(lines[start + 1]).map((cell) =>
		cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left",
	);
	let next = start + 2;
	while (next < lines.length && isTableRow(lines[next])) {
		rows.push(tableCells(lines[next]));
		next += 1;
	}
	const columns = Math.max(rows[0].length, aligns.length);
	const widths: number[] = [];
	for (let c = 0; c < columns; c += 1) widths.push(Math.max(...rows.map((row) => (row[c] ?? "").length), 1));
	const totalWidth = widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 3;
	if (totalWidth > 64) {
		// Too wide for a phone screen padded; keep it monospace but compact.
		const compact = rows.map((row) => row.slice(0, columns).map((cell) => cell ?? "").join(" | ")).join("\n");
		return { html: `<pre>${escapeHtml(compact)}</pre>`, next };
	}
	const line = (cells: string[], divider = false): string =>
		cells
			.slice(0, columns)
			.map((cell, c) => {
				const width = widths[c] ?? 1;
				if (divider) return "-".repeat(width);
				const align = aligns[c] ?? "left";
				const pad = width - cell.length;
				if (align === "right") return `${" ".repeat(pad)}${cell}`;
				if (align === "center") return `${" ".repeat(Math.floor(pad / 2))}${cell}${" ".repeat(Math.ceil(pad / 2))}`;
				return `${cell}${" ".repeat(pad)}`;
			})
			.join(" | ");
	const block = [line(rows[0]), line(aligns.map(() => "-"), true), ...rows.slice(1).map((row) => line(row))].join("\n");
	return { html: `<pre>${escapeHtml(block)}</pre>`, next };
}

/** Markdown (with fenced code) -> Telegram HTML. */
export function mdToHtml(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;
	let marker = "";
	let fenceLines: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fence = FENCE_RE.exec(line);
		if (!inFence && fence) {
			inFence = true;
			marker = fence[1];
			fenceLines = [];
			continue;
		}
		if (inFence) {
			if (isFenceEnd(line, marker)) {
				out.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
				inFence = false;
				fenceLines = [];
				continue;
			}
			fenceLines.push(line);
			continue;
		}
		const table = renderTable(lines, index);
		if (table) {
			out.push(table.html);
			index = table.next - 1;
			continue;
		}
		out.push(inlineToHtml(line));
	}
	if (inFence) out.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
	return out.join("\n");
}

/**
 * Hard-split one over-long line. Prefers a space near the limit so prose and URLs stay readable,
 * but always makes progress (a huge base64 blob still has to fit somewhere).
 */
export function splitLongLine(line: string, limit: number): string[] {
	if (line.length <= limit) return [line];
	const pieces: string[] = [];
	let rest = line;
	while (rest.length > limit) {
		let cut = limit;
		const space = rest.lastIndexOf(" ", limit);
		if (space > limit * 0.5) cut = space + 1;
		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length) pieces.push(rest);
	return pieces;
}

/** Split an oversized markdown block into pieces that each have balanced code fences. */
function splitOversizedBlock(block: string, limit: number): string[] {
	const pieces: string[] = [];
	let buffer: string[] = [];
	let size = 0;
	let inFence = false;
	let marker = "";
	const flush = (closeFence: boolean) => {
		if (!buffer.length && !closeFence) return;
		const body = buffer.join("\n");
		pieces.push(closeFence ? `${body}\n${marker}` : body);
		buffer = [];
		size = 0;
	};
	for (const rawLine of block.split("\n")) {
		for (const line of splitLongLine(rawLine, limit)) {
			if (size + line.length + 1 > limit && buffer.length) {
				flush(inFence);
				if (inFence) {
					buffer = [marker];
					size = marker.length;
				}
			}
			buffer.push(line);
			size += line.length + 1;
			const fence = FENCE_RE.exec(line);
			if (fence) {
				if (inFence && isFenceEnd(line, marker)) inFence = false;
				else if (!inFence) {
					inFence = true;
					marker = fence[1];
				}
			}
		}
	}
	flush(false);
	return pieces.filter((piece) => piece.trim().length > 0);
}

/** Split markdown into chunks that stay inside the Telegram limit and keep fences balanced. */
export function chunkMarkdown(markdown: string, limit = CHUNK_LIMIT): string[] {
	const text = markdown.replace(/\s+$/g, "");
	if (!text) return [];
	if (text.length <= limit) return [text];
	const lines = text.split("\n");
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;
	for (const line of lines) {
		current.push(line);
		const fence = FENCE_RE.exec(line);
		if (fence) inFence = !inFence;
		if (!inFence && line.trim() === "") {
			blocks.push(current.join("\n"));
			current = [];
		}
	}
	if (current.length) blocks.push(current.join("\n"));

	const chunks: string[] = [];
	let chunk = "";
	const push = () => {
		if (chunk.trim()) chunks.push(chunk.trim());
		chunk = "";
	};
	for (let block of blocks) {
		if (block.length > limit) {
			push();
			for (const piece of splitOversizedBlock(block, limit)) chunks.push(piece.trim());
			continue;
		}
		const candidate = chunk ? `${chunk}\n${block}` : block;
		if (candidate.length > limit) {
			push();
			chunk = block;
		} else {
			chunk = candidate;
		}
	}
	push();
	return chunks;
}

/**
 * Markdown -> HTML chunks that fit Telegram. HTML tags inflate the text, so the markdown budget
 * shrinks until every piece fits; content is never dropped.
 */
export function toHtmlChunks(markdown: string, limit = CHUNK_LIMIT): string[] {
	const fit = TELEGRAM_MESSAGE_LIMIT - 100;
	const budget0 = Math.max(64, Math.min(limit, fit));
	const out: string[] = [];
	for (const chunk of chunkMarkdown(markdown, budget0)) {
		const rendered = mdToHtml(chunk);
		if (rendered.length <= TELEGRAM_MESSAGE_LIMIT) {
			out.push(rendered);
			continue;
		}
		let budget = Math.floor(budget0 / 2);
		let pieces = chunkMarkdown(chunk, budget).map((piece) => mdToHtml(piece));
		while (budget > 32 && pieces.some((piece) => piece.length > TELEGRAM_MESSAGE_LIMIT)) {
			budget = Math.floor(budget / 2);
			pieces = chunkMarkdown(chunk, budget).map((piece) => mdToHtml(piece));
		}
		for (const piece of pieces) {
			if (piece.length <= TELEGRAM_MESSAGE_LIMIT) out.push(piece);
			else out.push(...splitUnfixableHtml(piece, fit));
		}
	}
	return out.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Last resort for a piece that is still oversized (heavy escaping, giant tables): unwrap the tags
 * and split the plain text. Ugly, but the answer stays complete.
 */
function splitUnfixableHtml(html: string, limit: number): string[] {
	const text = html
		.replace(/<\/?(b|i|s|u|code|pre|blockquote)>/g, "")
		.replace(/<a\b[^>]*>/g, "")
		.replace(/<\/a>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
	return splitLongLine(escapeHtml(text), limit);
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlockLike[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n").trim();
}

export function thinkingFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlockLike[]) {
		if (block && typeof block === "object" && block.type === "thinking" && block.thinking) parts.push(block.thinking);
	}
	return parts.join("\n").trim();
}

export function toolCallsFromContent(content: unknown): { id: string; name: string; arguments: unknown }[] {
	if (!Array.isArray(content)) return [];
	const calls: { id: string; name: string; arguments: unknown }[] = [];
	for (const block of content as ContentBlockLike[]) {
		if (block && typeof block === "object" && block.type === "toolCall" && block.name) {
			calls.push({ id: block.id ?? "", name: block.name, arguments: block.arguments });
		}
	}
	return calls;
}

export function imagesFromContent(content: unknown): { data: string; mimeType: string }[] {
	if (!Array.isArray(content)) return [];
	const images: { data: string; mimeType: string }[] = [];
	for (const block of content as ContentBlockLike[]) {
		if (block && typeof block === "object" && block.type === "image" && block.data && block.mimeType) {
			images.push({ data: block.data, mimeType: block.mimeType });
		}
	}
	return images;
}

/** Best-effort text of a tool result payload. */
export function resultText(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	const record = result as { content?: unknown; details?: { output?: string; content?: string } };
	const fromContent = textFromContent(record.content);
	if (fromContent) return fromContent;
	if (typeof record.details?.output === "string") return record.details.output;
	if (typeof record.details?.content === "string") return record.details.content;
	try {
		return JSON.stringify(result);
	} catch {
		return "";
	}
}

const ARG_KEYS = ["command", "cmd", "script", "path", "file_path", "filePath", "notebook_path", "pattern", "query", "url", "prompt", "text", "code", "name", "title", "question"];

/** One-line description of a tool call, mirroring what pi shows in the terminal. */
export function summarizeToolCall(name: string, args: unknown, maxLength = 140): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const picked: string[] = [];
	for (const key of ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			picked.push(key === "command" || key === "cmd" || key === "script" ? value.trim() : value.trim());
			break;
		}
	}
	if (name === "read" && (typeof record.offset === "number" || typeof record.limit === "number")) {
		const from = record.offset ?? 1;
		const to = typeof record.limit === "number" ? Number(from) + Number(record.limit) - 1 : "";
		picked.push(`L${from}${to ? `-${to}` : ""}`);
	}
	if (name === "edit" && Array.isArray(record.edits)) picked.push(`${record.edits.length} edits`);
	if (name === "todowrite" && Array.isArray(record.todos)) picked.push(`${record.todos.length} todos`);
	if (picked.length === 0) {
		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "string" && value.trim()) {
				picked.push(`${key}=${value.trim()}`);
				break;
			}
			if (typeof value === "number" || typeof value === "boolean") {
				picked.push(`${key}=${value}`);
				break;
			}
		}
	}
	const summary = picked.join(" \u00b7 ");
	return summary.length > maxLength ? `${summary.slice(0, maxLength)}\u2026` : summary;
}

export function truncate(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength)}\n\u2026 (${trimmed.length - maxLength} more chars)`;
}

const SECRET_PATTERNS: { pattern: RegExp; redact: (match: string) => string }[] = [
	// common key prefixes: sk-…, key-…, ghp_…, xoxb-…, AKIA…
	{ pattern: /\b(?:sk|key|ghp|xox[baprs]|AKIA|AIza)[A-Za-z0-9_-]{12,}\b/g, redact: (match) => `${match.slice(0, 6)}…${match.length - 6} chars` },
	// Authorization / Bearer values
	{ pattern: /\b(bearer|authorization|api[_ -]?key|token|secret)\s*[:=]\s*\S+/gi, redact: (match) => `${match.split(/[:=]/, 1)[0]}: [redacted]` },
	// URLs: host only, so path segments such as /keys/<token> cannot carry a credential
	{
		pattern: /https?:\/\/[^\s"'<]+/gi,
		redact: (match) => {
			try {
				return new URL(match).host;
			} catch {
				return "[url redacted]";
			}
		},
	},
];

/**
 * Provider and HTTP error text often repeats the credential it was sent with (OpenRouter does
 * exactly this). Telegram chats are a second copy of the transcript, so strip secrets first.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const { pattern, redact } of SECRET_PATTERNS) out = out.replace(pattern, redact);
	// long opaque blobs that are not URLs (tokens pasted into a message body)
	return out.replace(/\b[A-Za-z0-9+/_-]{32,}=*\b/g, (match) => `${match.slice(0, 6)}…${match.length - 6} chars`);
}

export function formatDuration(ms: number | undefined): string {
	if (!ms && ms !== 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	if (minutes < 60) return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatCount(value: number | undefined): string {
	if (value == null || Number.isNaN(value)) return "0";
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatCost(value: number | undefined): string {
	if (value == null || Number.isNaN(value)) return "";
	return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`;
}

export function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * HTML for a live draft message: markdown converted, then truncated on the *markdown*
 * side so code fences stay balanced and tags never get cut in half.
 */
export function draftHtml(markdown: string, limit = 3000): string {
	if (markdown.length <= limit) return mdToHtml(markdown);
	let slice = markdown.slice(0, limit);
	const fences = (slice.match(/```/g) ?? []).length;
	if (fences % 2 === 1) slice += "\n\n```";
	return `${mdToHtml(slice)}\n\n<i>… streaming · ${formatCount(markdown.length - limit)} more chars</i>`;
}
