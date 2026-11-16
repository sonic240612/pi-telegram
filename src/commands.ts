/**
 * Telegram-side command layer: pi commands re-expressed for a chat window.
 *
 * pi's built-in slash commands live in the terminal, so the useful ones
 * (/model, /thinking, /compact, /new, /resume, /fork, /tree, /rename, /reload)
 * are re-implemented on top of the extension API. Extension, skill, and prompt
 * template commands are passed straight through with `expandPromptTemplates`.
 */
import type { CallbackActionKind, CallbackEntry, CallbackResult, Hub, ListSpec, SendOptions } from "./hub.ts";
import { credentialHits, escapeHtml, formatBytes, formatCount, formatDuration, inlineCode, redactSecrets, tgDebug, truncate } from "./format.ts";
import { goalCardHtml, goalStatusLabel } from "./goal.ts";
import { L, pick, render } from "./i18n.ts";
import type { Lang, Localized } from "./i18n.ts";
import type { TgInlineKeyboardButton } from "./telegram.ts";

export interface CommandInvocation {
	chatId: number;
	userId: number;
	/** Command name without the leading slash, lower-cased. */
	command: string;
	args: string;
	raw: string;
}

export interface MenuEntry {
	command: string;
	description: string;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Registered with Telegram's command menu (names must be [a-z0-9_]). */
export const TELEGRAM_MENU: MenuEntry[] = [
	{ command: "help", description: "명령어 목록 / commands" },
	{ command: "status", description: "세션·모델 상태 / session status" },
	{ command: "model", description: "모델 선택 / select model" },
	{ command: "thinking", description: "thinking 레벨 / thinking level" },
	{ command: "compact", description: "컨텍스트 압축 / compact" },
	{ command: "new", description: "새 세션 / new session" },
	{ command: "resume", description: "세션 불러오기 / resume" },
	{ command: "fork", description: "이전 프롬프트에서 포크 / fork" },
	{ command: "tree", description: "세션 트리 이동 / navigate tree" },
	{ command: "rename", description: "세션 이름 / rename session" },
	{ command: "usage", description: "컨텍스트 사용량 / context usage" },
	{ command: "tools", description: "도구 켜기끄기 / toggle tools" },
	{ command: "commands", description: "pi 명령어 / pi commands" },
	{ command: "skills", description: "스킬 실행 / run a skill" },
	{ command: "abort", description: "실행 중단 / abort" },
	{ command: "steer", description: "실행 중 지시 / steer" },
	{ command: "queue", description: "끝난 후 전달 / follow-up" },
	{ command: "bash", description: "셸 명령 / run shell" },
	{ command: "export", description: "세션 파일 전송 / send session file" },
	{ command: "verbose", description: "표시 상세도 / detail level" },
	{ command: "stream", description: "실시간 초안 / live draft" },
	{ command: "tg", description: "브리지 관리 / bridge admin" },
	{ command: "pair", description: "채팅 허용 / pair chat" },
	{ command: "ping", description: "연결 확인 / connectivity" },
	{ command: "stats", description: "지연 통계 / latency stats" },
	{ command: "chats", description: "페어링된 채팅 / paired chats" },
	{ command: "pending", description: "승인 대기 채팅 / pending chats" },
	{ command: "unpair", description: "채팅 차단 / revoke a chat" },
	{ command: "restart", description: "브리지 재시작 / restart bridge" },
	{ command: "menu", description: "버튼 메뉴 / button menu" },
	{ command: "start", description: "처음 시작 / start here" },
];

/** Built-ins that only make sense in the terminal. */
/**
 * Keyboard labels are one line and Telegram hard-caps them at 64 characters, so clip here instead
 * of reusing truncate(): its "… (n more chars)" note contains a newline and makes the string
 * longer, which is exactly what makes an entire keyboard fail to send.
 */
function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

const TERMINAL_ONLY = ["settings", "scoped-models", "import", "share", "bug", "copy", "hotkeys", "changelog", "clone", "trust", "login", "logout", "init", "yolo", "autocompile"];

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

interface ListItem {
	label: string;
	kind: CallbackActionKind;
	value: string;
}

interface ListRender {
	title: Localized;
	items: ListItem[];
	perPage: number;
	columns: number;
	note?: Localized;
}

/**
 * Assemble one message out of pieces that may each be plain or per-chat, so a reply can be built once
 * and rendered in whichever language the chat turns out to speak.
 */
function joinLines(parts: Localized[]): (lang: Lang) => string {
	return (lang) => parts.map((part) => (typeof part === "string" ? part : part(lang))).join(String.fromCharCode(10));
}

export class CommandLayer {
	readonly hub: Hub;

	constructor(hub: Hub) {
		this.hub = hub;
	}

	async handle(inv: CommandInvocation): Promise<void> {
		const chatId = inv.chatId;
		switch (inv.command) {
			case "start":
			case "help":
				return this.help(chatId);
			case "menu":
				return this.rootMenu(chatId);
			case "ping":
				return this.ping(chatId);
			case "status":
			case "session":
				return this.status(chatId);
			case "model":
			case "models":
				return this.model(chatId, inv.args);
			case "thinking":
				return this.thinking(chatId, inv.args);
			case "compact":
				return this.compact(chatId, inv.args);
			case "new":
				return this.newSession(chatId);
			case "resume":
				return this.renderList(chatId, { list: "resume", args: inv.args, page: 0 });
			case "fork":
				return this.renderList(chatId, { list: "fork", args: inv.args, page: 0 });
			case "tree":
				return this.renderList(chatId, { list: "tree", args: inv.args, page: 0 });
			case "rename":
			case "name":
				return this.rename(chatId, inv.args);
			case "usage":
				return this.usage(chatId);
			case "tools":
				return this.tools(chatId, inv.args);
			case "commands":
			case "prompts":
				return this.renderList(chatId, { list: "commands", args: inv.args, page: 0 });
			case "skills":
				return this.renderList(chatId, { list: "skills", args: inv.args, page: 0 });
			case "abort":
			case "stop":
			case "cancel":
				return this.abort(chatId);
			case "steer":
				return this.deliver(chatId, inv.args, "steer");
			case "queue":
			case "followup":
				return this.deliver(chatId, inv.args, "followUp");
			case "bash":
				return this.bash(chatId, inv.args);
			case "export":
				return this.exportSession(chatId);
			case "verbose":
				return this.verbose(chatId, inv.args);
			case "stream":
				return this.stream(chatId, inv.args);
			case "reload":
				return this.reload(chatId);
			case "tg":
				return this.bridgeCommand(chatId, inv.args);
			case "pair":
				return this.pair(chatId);
			case "chats":
				return this.chats(chatId);
			case "stats":
				return this.tgStats(chatId);
			case "pending":
				return this.bridgeCommand(chatId, "pending");
			case "unpair":
				return this.bridgeCommand(chatId, `unpair ${inv.args}`.trim());
			case "restart":
				return this.bridgeCommand(chatId, "restart");
			default:
				return this.passThrough(chatId, inv);
		}
	}

	// ---------------------------------------------------------------- text commands

	private async help(chatId: number): Promise<void> {
		// the section labels follow the chat; the command list itself is the same either way
		const sections: [Localized, string][] = [
			[L("세션", "session"), "/new · /resume [search] · /fork [message] · /tree · /rename <name> · /export · /compact [note]"],
			[L("모델·도구", "models & tools"), "/model [name|search] · /thinking [off|minimal|low|medium|high] · /tools [list|on|off|reset|<name>]"],
			[L("실행", "running a turn"), "/abort · /steer <message> · /queue <message> · /bash <shell command>"],
			[L("상태·표시", "status & display"), "/status · /usage · /commands · /skills · /verbose [0|1|2] · /stream [on|off] · /ping · /stats"],
			[L("브리지", "the bridge itself"), "/pair · /chats · /pending · /unpair <chat id> · /restart · /tg status|pair|unpair|chats|pending|restart|verbose|stream|activity|lang|stats|menu|redact|goal|bridge"],
		];
		const body = (lang: Lang) => sections.map(([title, list]) => `<b>${escapeHtml(render(title, lang))}</b>\n${list}`).join("\n\n");
		const notes: Localized[] = [
			"",
			L("<i>일반 텍스트는 그대로 pi 프롬프트, 이미지와 텍스트·코드 파일은 첨부로 전달돼요. PDF·엑셀 같은 파일은 컴퓨터에 저장한 뒤 경로를 말해 주세요.</i>", "<i>plain text becomes a pi prompt exactly as typed; images and text/code files arrive as attachments. For PDFs, spreadsheets and the like, keep the file on the machine and tell me its path.</i>"),
			L("<i>pi 확장·스킬·프롬프트 템플릿 명령도 그대로 동작: /review, /skill:pdf, /mytemplate …</i>", "<i>pi extension, skill and prompt-template commands work here too: /review, /skill:pdf, /mytemplate …</i>"),
			L("<i>자동완성에 안 보이는 명령도 그대로 쳐면 동작해요. 자동완성 목록이 이상하면 /tg menu</i>", "<i>a command missing from autocomplete still works when typed. If that list looks wrong, /tg menu</i>"),
		];
		const rows: TgInlineKeyboardButton[][] = [
			["model", "thinking", "tools"].map((name) => this.menuButton(chatId, `🧠 ${name}`, name)),
			["commands", "skills", "resume"].map((name) => this.menuButton(chatId, `⌨️ ${name}`, name)),
			["status", "usage", "verbose 2"].map((name) => this.menuButton(chatId, `📊 ${name.trim()}`, name)),
		];
		await this.say(
			chatId,
			(lang) => `<b>pi-telegram</b>

${body(lang)}
${joinLines(notes)(lang)}`,
			{ keyboard: rows },
		);
	}

	private async rootMenu(chatId: number): Promise<void> {
		const rows: TgInlineKeyboardButton[][] = [
			["model", "thinking", "tools"].map((name) => this.menuButton(chatId, name, name)),
			["new", "resume", "fork"].map((name) => this.menuButton(chatId, name, name)),
			["status", "usage", "abort"].map((name) => this.menuButton(chatId, name, name)),
		];
		await this.say(chatId, "<b>pi-telegram menu</b>", { keyboard: rows });
	}

	private async ping(chatId: number): Promise<void> {
		const ctx = this.hub.tryPiContext();
		await this.say(
			chatId,
			`🏓 <b>pong</b>\nbot ${inlineCode(this.hub.botName())}\npi ${inlineCode(ctx ? "connected" : "detached")}\nchats ${inlineCode(String(this.hub.chats().length))}\nuptime ${inlineCode(formatDuration(this.hub.uptimeMs()))} · ${inlineCode(this.hub.isIdle() ? "idle" : "running")}`,
		);
	}

	private async status(chatId: number): Promise<void> {
		const info = this.hub.sessionInfo();
		const usage = this.hub.contextUsage();
		const active = this.hub.listTools().filter((tool) => tool.active).map((tool) => tool.name);
		const goal = this.hub.goalState().goal;
		const parts: Localized[] = [
			`🤖 <b>${escapeHtml(this.hub.botName())}</b> ↔ pi`,
			`model ${inlineCode(this.hub.currentModelKey() ?? "none")}`,
			`thinking ${inlineCode(this.hub.thinkingLevel())}`,
			`session ${inlineCode(this.hub.sessionName() ?? info.id)}`,
			`file ${inlineCode(info.file ?? "(unsaved)")}`,
			`cwd ${inlineCode(info.cwd)}`,
			`entries ${inlineCode(String(info.entries))} · messages ${inlineCode(String(info.messages))}`,
			`context ${inlineCode(usage?.percent != null ? `${usage.percent.toFixed(1)}%` : usage?.tokens != null ? `${formatCount(usage.tokens)} tok` : "unknown")}`,
			`tools ${inlineCode(active.join(", ") || "none")}`,
			(lang) =>
				`detail ${inlineCode(String(this.hub.verbosity()))} · ${pick(lang, "초안", "drafts")} ${inlineCode(this.hub.cfg.streaming ? "on" : "off")} · ${pick(lang, `도구 ${this.hub.cfg.activityLive ? "실시간" : "마지막 요약"}`, `tools ${this.hub.cfg.activityLive ? "live" : "summarised at turn end"}`)} · ${inlineCode(this.hub.isIdle() ? "idle" : "running")}`,
		];
		// A goal is the one thing /status cannot show from pi's own state, and the one thing a phone
		// user most needs to see while pi runs unattended.
		if (goal) {
			parts.push(`goal ${goalStatusLabel(goal.status)} ${inlineCode(truncate(goal.id, 24))}${goal.tasksTotal ? ` · ${goal.tasksDone}/${goal.tasksTotal}` : ""} · ${formatCount(goal.tokensUsed)} tok <i>(/tg goal)</i>`);
		}
		// More than one pi window can answer this bot; the phone should know which one it is talking to.
		const windows = this.hub.bridgeSessions();
		if (windows.length > 1) {
			parts.push(
				(lang) =>
					`${pick(lang, "pi 세션", "pi sessions")}: ${windows.length} · ${pick(lang, "이 창", "this window")} ${inlineCode(windows.find((w) => w.here)?.label ?? "?")} ${windows.find((w) => w.here)?.connected ? pick(lang, "연결됨", "connected") : pick(lang, "기다리는 중", "waiting")} · ${inlineCode("/tg bridge")}`,
			);
		}
		await this.say(chatId, joinLines(parts));
	}

	private async model(chatId: number, args: string): Promise<void> {
		const query = args.trim();
		if (query) {
			// A provider such as openrouter carries hundreds of models, so a typed reference searches
			// everything pi knows about — not only the handful it considers "available".
			const pool = this.hub.searchModels(query, 400);
			// `openrouter/anthropic/claude-sonnet-4.5` or `nvidia/nemotron-3.5-super-vl:free` typed in full
			// is an instruction, not a search: apply it instead of showing a keyboard.
			const exact = pool.find((model) => model.id.toLowerCase() === query.toLowerCase() || model.key.toLowerCase() === query.toLowerCase());
			if (exact) return this.applyModelRef(chatId, exact.key, query);
			const matches = pool.slice(0, 80);
			if (matches.length === 1) return this.applyModelRef(chatId, matches[0].key, query);
			if (!matches.length) {
				if (query.includes("/")) {
					// pi has never seen this id, but a provider can still resolve it (known provider, or an
					// aggregator whose ids embed the manufacturer): use the provider's shape as-is.
					return this.applyModelRef(chatId, query);
				}
				await this.say(chatId, (lang) => {
					const head = pick(lang, `⚠️ 일치하는 모델이 없어요: ${inlineCode(query)}`, `⚠️ no model matches: ${inlineCode(query)}`);
					const hint = pick(
						lang,
						`${inlineCode("/model")} ${pick(lang, "목록에서 고르거나", "shows the list; or")} ${inlineCode("provider/id")} ${pick(lang, "를 그대로 치면 그 id를 바로 써요.", "typed exactly is used as written.")}`,
						`${inlineCode("/model")} shows the list; type the exact ${inlineCode("provider/id")} and that id is used as written.`,
					);
					return `${head}\n${hint}`;
				});
				return;
			}
			return this.renderList(chatId, { list: "model", args: query, page: 0 });
		}
		const curated = this.hub.listModels();
		if (curated.length > 40) {
			// paging through 400 usable ids is useless — ask which provider, or for a search term
			return this.renderList(chatId, { list: "model:providers", args: "", page: 0 });
		}
		await this.renderList(chatId, { list: "model", args: query, page: 0 });
	}

	private async applyModelRef(chatId: number, key: string, typed?: string): Promise<void> {
		const result = await this.hub.setModelByKey(key);
		if (!result.ok) {
			await this.say(chatId, (lang) => `⚠️ ${pick(lang, "모델 변경 실패", "could not change the model")}: ${escapeHtml(result.error ? render(result.error, lang) : "unknown")}`);
			return;
		}
		const applied = result.resolved ?? key;
		const asked = (typed ?? key).toLowerCase();
		await this.say(chatId, (lang) => {
			const renamed = applied.toLowerCase() !== asked ? `\n· ${inlineCode(typed ?? key)} → ${inlineCode(applied)} ${pick(lang, "로 해석했어요", "resolved to this")}` : "";
			const note = result.custom ? `\n✨ ${pick(lang, `pi가 처음 보는 id예요 — 같은 provider의 ${inlineCode(result.custom!.template)} 설정을 그대로 사용했어요.`, `pi has never seen this id — borrowed the settings of ${inlineCode(result.custom!.template)} from the same provider.`)}` : "";
			return `🔀 model → ${inlineCode(applied)}${renamed}${note}`;
		});
	}

	private async thinking(chatId: number, args: string): Promise<void> {
		const level = args.trim().toLowerCase();
		if (level) {
			if (!THINKING_LEVELS.includes(level)) {
				await this.say(chatId, (lang) => `⚠️ ${pick(lang, "레벨 선택", "pick a level")}: ${THINKING_LEVELS.map((entry) => inlineCode(entry)).join(" ")}`);
				return;
			}
			const result = this.hub.setThinkingLevel(level);
			await this.say(chatId, (lang) => (result.ok ? `🧠 thinking → ${inlineCode(level)}` : `⚠️ ${pick(lang, "thinking 변경 실패", "could not change thinking")}: ${escapeHtml(result.error ? render(result.error, lang) : "unknown")}`));
			return;
		}
		await this.renderThinking(chatId);
	}

	private async renderThinking(chatId: number): Promise<void> {
		const current = this.hub.thinkingLevel();
		const rows = [THINKING_LEVELS.map((level) => ({ text: `${level === current ? "● " : ""}${level}`, callback_data: this.hub.createToken({ kind: "thinking:pick", value: level }, chatId) }))];
		await this.say(chatId, (lang) => `<b>thinking level</b> · ${pick(lang, "현재", "current")} ${inlineCode(current)}\n${pick(lang, "모델이 지원하지 않는 레벨은 자동으로 제한됩니다.", "levels a model cannot do are capped automatically.")}`, { keyboard: rows });
	}

	private async compact(chatId: number, args: string): Promise<void> {
		const result = this.hub.compactRun(args.trim() || undefined);
		await this.say(chatId, (lang) => (result.ok ? `🗜️ ${pick(lang, "압축 시작", "compaction started")}${args.trim() ? ` · ${inlineCode(truncate(args.trim(), 120))}` : ""}` : `⚠️ compact ${pick(lang, "실패", "failed")}: ${escapeHtml(result.error ? render(result.error, lang) : "unknown")}`));
	}

	private async newSession(chatId: number): Promise<void> {
		await this.say(chatId, L("🆕 새 세션 여는 중…", "🆕 opening a new session…"));
		// /new disposes the pi session and re-creates this extension, so this instance cannot confirm;
		// the notice is queued for the bridge instance that comes back up.
		const notice = this.hub.notifyAfterRestart(L("🆕 <b>새 세션</b>이 열렸어요. 여기서 이어서하면 돼요.", "🆕 <b>a new session</b> is open. Carry on from here."));
		try {
			await this.hub.withCommandContext(async (ctx) => {
				await ctx.newSession();
			});
			this.hub.clearPendingNotice(notice);
			await this.say(chatId, L("✅ 새 세션이 열렸어요.", "✅ the new session is open."));
		} catch (error) {
			this.hub.clearPendingNotice(notice);
			await this.quietSay(chatId, (lang) => `⚠️ ${pick(lang, "새 세션 실패", "the new session failed")}: ${escapeHtml(safeError(error))}`);
		}
	}

	private async rename(chatId: number, args: string): Promise<void> {
		const name = args.trim();
		if (!name) {
			await this.say(chatId, (lang) => `${pick(lang, "현재 이름", "current name")} ${inlineCode(this.hub.sessionName() ?? "(none)")}\n${pick(lang, "사용법", "usage")}: ${inlineCode("/rename 이름")}`);
			return;
		}
		this.hub.setSessionName(name);
		await this.say(chatId, `🏷 ${pick(this.hub.lang(chatId), "이름", "name")} → ${inlineCode(name)}`);
	}

	private async usage(chatId: number): Promise<void> {
		const usage = this.hub.contextUsage();
		const info = this.hub.sessionInfo();
		if (!usage) {
			await this.say(chatId, (lang) => `📊 ${pick(lang, "컨텍스트 사용량을 아직 계산할 수 없어요 (pi가 처음 답하기 전일 수 있어요).", "context usage is not computed yet (pi may not have answered yet).")}\nentries ${inlineCode(String(info.entries))}`);
			return;
		}
		const percent = usage.percent ?? 0;
		const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
		await this.say(
			chatId,
			`📊 ${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${inlineCode(`${percent.toFixed(1)}%`)}\n${inlineCode(`${formatCount(usage.tokens ?? 0)} / ${formatCount(usage.contextWindow)} tokens`)}\n${inlineCode(`entries ${info.entries} · messages ${info.messages}`)}`,
		);
	}

	private async tools(chatId: number, args: string): Promise<void> {
		const query = args.trim();
		if (query) {
			const tools = this.hub.listTools();
			const target = tools.find((tool) => tool.name.toLowerCase() === query.toLowerCase());
			if (!target) {
				await this.say(chatId, (lang) => `⚠️ ${pick(lang, "도구 없음", "no such tool")}: ${inlineCode(query)}`);
				return;
			}
			const active = tools.filter((tool) => tool.active).map((tool) => tool.name);
			const next = target.active ? active.filter((name) => name !== target.name) : [...active, target.name];
			this.hub.setActiveTools(next);
			await this.say(chatId, `🔧 ${inlineCode(target.name)} ${target.active ? "off" : "on"} · active ${next.length}/${tools.length}`);
			return;
		}
		await this.renderList(chatId, { list: "tools", args: "", page: 0 });
	}

	private async abort(chatId: number): Promise<void> {
		if (this.hub.isIdle()) {
			await this.say(chatId, L("이미 idle 이에요.", "already idle."));
			return;
		}
		this.hub.abortRun();
		await this.say(chatId, L("⏹ 중단 요청 전송.", "⏹ stop requested."));
	}

	private async deliver(chatId: number, args: string, mode: "steer" | "followUp"): Promise<void> {
		const text = args.trim();
		if (!text) {
			await this.say(chatId, (lang) =>
				mode === "steer"
					? `${pick(lang, "사용법", "usage")}: ${inlineCode("/steer 메시지")} — ${pick(lang, "실행 중인 에이전트에게 바로 지시", "tell the running agent right away")}`
					: `${pick(lang, "사용법", "usage")}: ${inlineCode("/queue 메시지")} — ${pick(lang, "실행이 끝난 뒤 전달", "delivered once the run ends")}`,
			);
			return;
		}
		this.hub.noteTelegramInput(text);
		this.hub.sendToPi(text, { deliverAs: mode });
		await this.say(chatId, (lang) => (mode === "steer" ? pick(lang, "🧭 steer로 큐에 넣었어요.", "🧭 queued as a steer.") : pick(lang, "📮 follow-up으로 큐에 넣었어요.", "📮 queued as a follow-up.")));
	}

	private async bash(chatId: number, args: string): Promise<void> {
		const command = args.trim();
		if (!command) {
			await this.say(chatId, (lang) => `${pick(lang, "사용법", "usage")}: ${inlineCode("/bash <command>")}`);
			return;
		}
		await this.say(chatId, `💻 ${inlineCode(truncate(command, 200))}`);
		const result = await this.hub.runShell(command, 120_000);
		let body = [result.stdout, result.stderr].filter(Boolean).join("\n").replace(/\s+$/g, "");
		// Commands like `curl -H "Authorization: Bearer …"` echo credentials into the log. The terminal
		// keeps them; the Telegram copy of this run is scrubbed unless the chat opted out.
		if (this.hub.cfg.redactBash) body = redactSecrets(body);
		const head = `${result.code === 0 ? "✅" : "❌"} exit ${result.code}${result.truncated ? " · <i>truncated by pi</i>" : ""}${result.killed ? " · <i>killed</i>" : ""}`;
		if (!body.trim()) {
			await this.say(chatId, head);
			return;
		}
		if (body.length > 3000) {
			// Too long for a message: show the head inline and send the whole thing as a file, so
			// nothing is lost the way the terminal would let you scroll back.
			await this.say(chatId, `${head}\n<pre>${escapeHtml(truncate(body, 1200))}</pre>`);
			await this.hub.sendFile(chatId, new TextEncoder().encode(body), `bash-output-${Date.now()}.txt`, `full output · ${formatBytes(body.length)}`);
			return;
		}
		await this.say(chatId, `${head}\n<pre>${escapeHtml(body)}</pre>`);
	}

	private async exportSession(chatId: number): Promise<void> {
		const path = this.hub.sessionFilePath();
		if (!path) {
			await this.say(chatId, L("⚠️ 아직 파일로 저장되지 않은 세션이에요.", "⚠️ this session has not been saved to a file yet."));
			return;
		}
		try {
			const { readFileSync } = await import("node:fs");
			const data = Uint8Array.from(readFileSync(path));
			const name = path.split(/[\\/]/).pop() ?? "session.jsonl";
			// The transcript is a second copy of everything pi handled, tool output included.
			const hits = credentialHits(Buffer.from(data).toString("utf8"));
			const caption: Localized = (lang) => `📦 ${escapeHtml(this.hub.sessionName() ?? this.hub.sessionInfo().id)} · ${formatBytes(data.byteLength)}${hits ? ` · ⚠️ ${pick(lang, "credential처럼 보이는 문자열", "strings that look like credentials")} ${hits}` : ""}`;
			await this.hub.sendFile(chatId, data, name, caption);
		} catch (error) {
			await this.say(chatId, (lang) => `⚠️ export ${pick(lang, "실패", "failed")}: ${escapeHtml(safeError(error))}`);
		}
	}

	private async verbose(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		const map: Record<string, 0 | 1 | 2> = { "0": 0, "1": 1, "2": 2, off: 0, min: 1, minimal: 1, low: 1, full: 2, max: 2 };
		if (raw) {
			const level = map[raw];
			if (level == null) {
				await this.say(chatId, (lang) => `${pick(lang, "사용법", "usage")}: ${inlineCode("/verbose 0|1|2")}\n0 ${pick(lang, "답장만", "answers only")} · 1 ${pick(lang, "답장+도구 게시판", "answers + live tool board")} · 2 ${pick(lang, "전체 미러링(thinking·결과 원문)", "full mirror (thinking · raw results)")}`);
				return;
			}
			this.hub.cfg.verbosity = level;
			this.hub.save();
		}
		await this.say(chatId, (lang) => {
			const labels = [pick(lang, "답장만", "answers only"), pick(lang, "답장 + 도구 게시판", "answers + live tool board"), pick(lang, "전체 미러링", "full mirror")];
			return `🔍 detail ${this.hub.verbosity()} — ${labels[this.hub.verbosity()] ?? ""}${this.hub.verbosity() === 1 ? ` · ${pick(lang, "기본값", "default")}` : ""}`;
		});
	}

	private async stream(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		if (raw === "on" || raw === "off") {
			this.hub.cfg.streaming = raw === "on";
			this.hub.save();
		}
		await this.say(chatId, (lang) => `✍️ ${pick(lang, "실시간 초안", "live drafts")} ${this.hub.cfg.streaming ? "on" : "off"}`);
	}

	/**
	 * Detail level 1 writes each turn's tool activity into one message that is edited as tools run —
	 * pi's status line, in the chat — instead of one summary when the turn ends.
	 */
	private async activity(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		const detail = this.hub.verbosity();
		if (raw === "on" || raw === "off") {
			this.hub.cfg.activityLive = raw === "on";
			this.hub.save();
			const mode = this.hub.cfg.activityLive ? true : false;
			void mode;
			await this.say(chatId, (lang) => {
				const elsewhere = detail === 1 ? "" : `\n<i>${pick(lang, `지금은 상세 ${inlineCode(String(detail))}이라 이 게시판은 안 보여요 — 상세 1에서 동작해요.`, `at detail ${inlineCode(String(detail))} there is no board — it lives at detail 1.`)}</i>`;
				const mode = this.hub.cfg.activityLive
					? pick(lang, "🔧 도구 게시판 on — 한 턴이 메시지 하나로 끝나고, 도구가 진행되는 동안 그 메시지가 업데이트돼요.", "🔧 tool board on — one message per turn, edited while the tools run.")
					: pick(lang, "🔧 도구 게시판 off — 턴이 끝난 뒤 요약 메시지 하나만 보내요.", "🔧 tool board off — one summary after the turn ends.");
				return mode + elsewhere;
			});
			return;
		}
		await this.say(
			chatId,
			joinLines([
				(lang) => `🔧 ${pick(lang, "도구 게시판", "tool board")}: <b>${this.hub.cfg.activityLive ? pick(lang, "실시간 업데이트", "updated live") : pick(lang, "턴 끝에 요약만", "summarised at turn end")}</b> · ${pick(lang, "현재 상세", "current detail")} ${inlineCode(String(detail))}`,
				(lang) =>
					detail === 1
						? `<i>${pick(lang, "전환", "toggle")}: ${inlineCode("/tg activity on|off")} · ${pick(lang, "상세 설정", "detail level")}: ${inlineCode("/verbose 0|1|2")}</i>`
						: `<i>${pick(lang, `이 설정은 상세 ${inlineCode("1")}에서만 동작해요 — 지금 상세에서는 영향이 없어요.`, `this setting only applies at detail ${inlineCode("1")} — it changes nothing at your detail level.`)}</i> · ${pick(lang, "상세 설정", "detail level")}: ${inlineCode("/verbose 0|1|2")}`,
			]),
		);
	}

	/** What language this chat hears, why, and how to change it. */
	private async language(chatId: number, args: string): Promise<void> {
		const raw = args.trim().toLowerCase();
		if (raw === "auto") {
			this.hub.setLang(chatId, undefined);
			await this.say(
				chatId,
				L(
					`🌐 이 채팅의 언어 고정을 풀었어요 — 다시 자동 감지하고, 지금 바로 ${inlineCode(this.hub.lang(chatId))}로 말해요.`,
					`🌐 released this chat's language pin — it follows detection again and speaks ${inlineCode(this.hub.lang(chatId))} right now.`,
				),
			);
			return;
		}
		if (raw === "ko" || raw === "en") {
			this.hub.setLang(chatId, raw);
			// Answer in the language that was just picked: that is the proof it took effect.
			await this.say(
				chatId,
			raw === "ko"
					? `🌐 <b>이 채팅은 이제 한국어로 말해요</b> — 브리지가 쓰는 메뉴·알림이 한국어로 바뀝니다. 답장 본문은 pi가 답하는 언어를 따라가요. · 되돌리기: ${inlineCode("/tg lang auto")}`
					: `🌐 <b>This chat now hears me in English</b> — the bridge's menus and notices switch to English. Answers still follow whatever language pi replies in. · to undo: ${inlineCode("/tg lang auto")}`,
			);
			return;
		}
		if (raw) {
			await this.say(chatId, L(`모르는 언어예요 — ${inlineCode("/tg lang ko|en|auto")}`, `unknown language — ${inlineCode("/tg lang ko|en|auto")}`));
			return;
		}
		const lang = this.hub.lang(chatId);
		const source = this.hub.langSource(chatId);
		// One string, not a Localized inside a Localized: interpolating a function would paste its source.
		const why =
			source === "chat"
				? pick(lang, `· 이 채팅에서 고정한 값 — ${inlineCode("/tg lang auto")}로 자동 감지로 되돌려요`, `· pinned for this chat — ${inlineCode("/tg lang auto")} hands it back to detection`)
				: source === "config"
					? pick(lang, `· ${inlineCode("telegram.json")}의 ${inlineCode("language")}로 고정 — 채팅별로 ${inlineCode("/tg lang ko|en")}로 바꿀 수 있어요`, `· fixed by ${inlineCode("language")} in ${inlineCode("telegram.json")} — ${inlineCode("/tg lang ko|en")} overrides it per chat`)
					: source === "telegram"
						? pick(lang, `· 텔레그램이 알려준 클라이언트 언어로 자동 감지 — ${inlineCode("/tg lang ko|en")}로 고칠 수 있어요`, `· detected from the language telegram reports for your client — override with ${inlineCode("/tg lang ko|en")}`)
						: pick(lang, `· 아직 이 채팅의 언어 신호를 못 봤어요 — 기본값은 영어`, `· no language signal from this chat yet — the fallback is English`);
		await this.say(
			chatId,
			lang === "ko"
				? `🌐 이 채팅에 쓰는 언어: <b>한국어</b>\n${why}\n<i>${inlineCode("/tg lang ko|en|auto")} · 브리지만 한국어/영어, pi 답장은 모델이 답하는 언어</i>`
				: `🌐 Language for this chat: <b>English</b>\n${why}\n<i>${inlineCode("/tg lang ko|en|auto")} · only the bridge speaks Korean/English; pi's answers come in whatever language pi replies</i>`,
		);
	}

	/** How hard the bridge scrubs credentials from the copies it makes for Telegram. */
	private async redact(chatId: number, args: string): Promise<void> {
		const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let scope: "bash" | "transcript" = "bash";
		if (parts[0] === "transcript") {
			scope = "transcript";
			parts.shift();
		} else if (parts[0] === "bash") {
			parts.shift();
		}
		const flag = parts[0];
		if (flag === "on" || flag === "1" || flag === "true" || flag === "off" || flag === "0" || flag === "false") {
			const value = flag === "on" || flag === "1" || flag === "true";
			if (scope === "bash") this.hub.cfg.redactBash = value;
			else this.hub.cfg.redactTranscript = value;
			this.hub.save();
		} else if (flag) {
			await this.say(chatId, (lang) => `⚠️ usage: ${inlineCode("/tg redact on|off")} ${pick(lang, "또는", "or")} ${inlineCode("/tg redact transcript on|off")}`);
			return;
		}
		await this.say(
			chatId,
			joinLines([
				(lang) => `<b>${pick(lang, "credential 지우기", "credential scrubbing")}</b>`,
				(lang) => `· /bash ${pick(lang, "로그", "log")}: ${this.hub.cfg.redactBash ? "on" : "off"}`,
				(lang) => `· ${pick(lang, "미러링되는 transcript", "mirrored transcript")}: ${this.hub.cfg.redactTranscript ? "on" : "off"}`,
				(lang) => `<i>${pick(lang, "pi/provider 에러와 브리지 알림은 항상 지워요 — provider가 요청에 쓰인 key를 에러문에 그대로 옮겨 적기 때문이에요. 보낸 key는 지워지지만 메시지 본문은 그대로 남아요.", "pi and provider errors and every bridge notice are always scrubbed — a provider copies the key used for the request straight into its error text. The key that was sent gets removed; message bodies are left alone.")}</i>`,
				`usage: ${inlineCode("/tg redact on|off")} · ${inlineCode("/tg redact transcript on|off")}`,
			]),
			{ markdown: false },
		);
	}

	private async reload(chatId: number): Promise<void> {
		await this.say(chatId, L("♻️ pi 리소스 reload 중…", "♻️ reloading pi resources…"));
		try {
			await this.hub.withCommandContext(async (ctx) => {
				await ctx.reload();
			});
			await this.say(chatId, L("✅ reload 완료 (브지도 다시 시작됩니다)", "✅ reload done (the bridge restarts with it)"));
		} catch (error) {
			await this.say(chatId, (lang) => `⚠️ reload ${pick(lang, "실패", "failed")}: ${escapeHtml(safeError(error))}`);
		}
	}

	private async bridgeCommand(chatId: number, args: string): Promise<void> {
		const parts = args.trim().split(/\s+/);
		const sub = (parts[0] ?? "").toLowerCase();
		const rest = parts.slice(1).join(" ");
		switch (sub) {
			case "":
			case "status":
				return this.status(chatId);
			case "pair":
				this.hub.pairThisChat(chatId);
				return this.say(chatId, L("🔗 이 채팅을 허용 목록에 넣었어요.", "🔗 this chat is on the allow list now."));
			case "unpair":
			case "leave":
				return this.say(chatId, this.hub.unpairChat(chatId) ? L("🔌 허용 목록에서 뺐어요. pi에서 /telegram-pair 로 다시 허용할 수 있어요.", "🔌 removed from the allow list. /telegram-pair in pi can let it back in.") : L("⚠️ 이미 허용 목록에 없어요.", "⚠️ that chat was never on the allow list."));
			case "chats":
				return this.chats(chatId);
			case "pending": {
				const pending = this.hub.pendingChats();
				return this.say(chatId, (lang) => (pending.length ? `<b>pending</b>\n${pending.map((entry) => `${escapeHtml(entry.label)} → ${inlineCode(entry.code)}`).join(String.fromCharCode(10))}\n${pick(lang, "pi 터미널에서", "in the pi terminal")} ${inlineCode("/telegram-pair <code>")}` : pick(lang, "pending 채팅 없음.", "no chats waiting for pairing.")));
			}
			case "restart":
				this.hub.restartBridge();
				return this.say(chatId, L("🔁 브리지 재시작했어요.", "🔁 restarting the bridge."));
			case "verbose":
				return this.verbose(chatId, rest);
			case "stream":
				return this.stream(chatId, rest);
			case "activity":
				return this.activity(chatId, rest);
			case "lang":
			case "language":
				return this.language(chatId, rest);
			case "redact":
				return this.redact(chatId, rest);
			case "stats":
			case "latency":
				return this.tgStats(chatId);
			case "menu":
				return this.tgMenu(chatId);
			case "bridge": {
				// Which pi window owns the connection — the answer to "why is my other window silent?"
				const sessions = this.hub.bridgeSessions();
				if (rest[0] === "off") {
					await this.hub.bridgeTurnOff();
					return this.say(
						chatId,
						(lang) =>
							`🔌 ${pick(
								lang,
								`이 pi 세션의 텔레그램 연결을 껐어요 — 이 채팅은 이제 이 세션에 닿지 않아요. 다른 pi 세션이 이어받을 수 있고, 어느 창에서든 ${inlineCode("/telegram on")} 로 다시 켤 수 있어요.`,
								`disconnected this pi session from telegram — this chat no longer reaches it. Another open pi session can take over, and ${inlineCode("/telegram on")} in any window's terminal turns it back on.`,
							)}`,
					);
				}
				return this.say(
					chatId,
					(lang) =>
						[
							`🔌 <b>${pick(lang, "pi 세션과 연결", "pi sessions and the connection")}</b>`,
							...sessions.map(
								(session) =>
									`${session.here ? "▸" : "·"} ${escapeHtml(session.label)} <i>pid ${session.pid}</i> — ${session.connected ? pick(lang, "연결됨", "connected") : pick(lang, "기다리는 중", "waiting")}`,
							),
							`<i>${pick(lang, "이 봇을 읽는 세션은 한 번에 하나만 — 다른 창으로 옮기려면 그 pi 터미널에서 /telegram on", "only one session reads this bot at a time — /telegram on in another window's terminal moves it there")}</i>`,
						].join(String.fromCharCode(10)),
				);
			}
			case "goal": {
				// pi-goal-x owns /goal; the phone-side view of the same state lives here.
				const state = this.hub.goalState();
				return this.say(chatId, goalCardHtml(state.goal, state.focus));
			}
			default:
				return this.say(chatId, (lang) => `${pick(lang, "사용법", "usage")}: ${inlineCode("/tg status|pair|unpair|chats|pending|restart|verbose|stream|activity|lang|stats|menu|redact|goal|bridge")}`);
		}
	}

	/** Where the wait lives: pi thinking, or telegram round-trips. Numbers the user can read on a phone. */
	private async tgStats(chatId: number): Promise<void> {
		const stats = this.hub.bridgeStats();
		const parts: Localized[] = [
			(lang) => `📊 <b>${pick(lang, "지연 통계", "latency report")}</b> · ${pick(lang, "연결 후", "connected for")} ${formatDuration(stats.uptimeMs)}`,
			(lang) => `${pick(lang, "전송", "sends")} ${stats.calls}${pick(lang, "회", "")} · ${pick(lang, "평균", "avg")} ${stats.avgMs}ms · ${pick(lang, "최고", "max")} ${stats.maxMs}ms`,
			(lang) => `${pick(lang, "폴링", "polling")} ${stats.polls.count}${pick(lang, "회", "")} (${pick(lang, "평균", "avg")} ${stats.polls.avgHoldMs}ms ${pick(lang, "대기 — 이건 지연이 아니에요", "held open — that is not delay")})`,
			(lang) => `${pick(lang, "프롬프트 → pi 실행 시작", "prompt → pi started")}: ${stats.promptToRunMs.length ? stats.promptToRunMs.map((ms) => `${ms}ms`).join(" · ") : pick(lang, "기록 없음", "nothing recorded")}`,
		];
		if (stats.slow.length) parts.push((lang) => `${pick(lang, "느린 호출", "slow calls")}: ${stats.slow.map((call) => `${escapeHtml(call.method)} ${call.ms}ms`).join(" · ")}`);
		if (stats.throttled.length) {
			const worst = Math.max(...stats.throttled.map((entry) => entry.retryAfter));
			parts.push((lang) => `telegram ${pick(lang, "속도 제한", "rate limits")} ${stats.throttled.length}${pick(lang, "회", "")} (${pick(lang, `최장 ${worst}s 대기`, `waited up to ${worst}s`)})`);
		}
		if (stats.menu.shadowed) parts.push((lang) => `⚠️ ${pick(lang, "자동완성 메뉴가 다른 프로그램에 의해 덮어써짐", "the autocomplete menu is shadowed by another program")} (${pick(lang, "등록", "registered")} ${stats.menu.registered} / ${pick(lang, "노출", "served")} ${stats.menu.served}) → /tg menu`);
		if (stats.avgMs > 1200) parts.push(L("<i>전송 왕복이 느려요 — 프록시/네트워크를 확인하세요 (TELEGRAM_API_ROOT로 우회 가능).</i>", "<i>the send round-trip is slow — check the proxy and the network (TELEGRAM_API_ROOT can route around it).</i>"));
		return this.say(chatId, joinLines(parts));
	}

	/** Re-register the "/" menu and say what telegram actually serves — autocomplete lies otherwise. */
	private async tgMenu(chatId: number): Promise<void> {
		const menu = await this.hub.refreshMenu();
		if (!menu.registered) return this.say(chatId, L("⚠️ <i>브리지 연결이 끊겨서 메뉴를 등록할 수 없어요. /restart </i>", "⚠️ <i>the bridge is disconnected, so no menu can be registered. /restart</i>"));
		const ours = TELEGRAM_MENU.map((entry) => entry.command);
		const foreign = menu.served.filter((name) => !ours.includes(name));
		const parts: Localized[] = [
			(lang) => `✅ <b>${pick(lang, "자동완성 메뉴 등록 완료", "autocomplete menu registered")}</b> · ${pick(lang, `${menu.registered}개 등록`, `${menu.registered} registered`)} · ${pick(lang, `텔레그램이 노출 중 ${menu.served}개`, `telegram shows ${menu.served}`)}`,
			menu.shadowed
				? L("⚠️ 우리 명령이 목록에 없어요 — 같은 봇 토큰을 쓰는 다른 pi/브리지 프로세스가 있습니다. 그 프로세스를 끈 뒤 /restart 하세요.", "⚠️ our commands are not in that list — another pi/bridge process is using the same bot token. Stop it, then /restart.")
			: L("<i>목록이 정상입니다. 자동완성이 갱신되지 않으면 채팅을 다시 여세요.</i>", "<i>the list looks right. If autocomplete has not refreshed, close and reopen the chat.</i>"),
		];
		if (foreign.length) parts.push((lang) => `${pick(lang, `다른 목록에서 온 명령 ${foreign.length}개`, `${foreign.length} commands from someone else`)}: ${foreign.slice(0, 12).map((name) => inlineCode(name)).join(" ")}`);
		parts.push(L("<i>메뉴에 없어도 명령은 그대로 쳐면 동작해요. 전체 목록은 /help</i>", "<i>a command missing from the menu still works when typed. /help lists everything.</i>"));
		return this.say(chatId, joinLines(parts));
	}

	private async pair(chatId: number): Promise<void> {
		this.hub.pairThisChat(chatId);
		await this.say(chatId, L("🔗 허용했어요. 이제 텍스트는 그대로 pi 프롬프트가 됩니다.", "🔗 paired. Your text is a pi prompt from here on."));
	}

	private async chats(chatId: number): Promise<void> {
		const paired = this.hub.pairedChats();
		const rows = paired.map((chat) => ({ text: `⛔ ${clip(chat.label, 24)}`, callback_data: this.hub.createToken({ kind: "chat:unpair", value: String(chat.chatId) }, chatId) }));
		const keyboard: TgInlineKeyboardButton[][] = [];
		for (let index = 0; index < rows.length; index += 2) keyboard.push(rows.slice(index, index + 2));
		await this.say(
			chatId,
			`<b>paired chats</b> · ${paired.length}\n${paired.map((chat) => `${chat.chatId} · ${escapeHtml(chat.label)} · ${new Date(chat.addedAt).toISOString().slice(0, 10)}`).join("\n")}`,
			keyboard.length ? { keyboard } : undefined,
		);
	}

	/** Unknown slash command: run pi's own extension/skill/template command. */
	private async passThrough(chatId: number, inv: CommandInvocation): Promise<void> {
		const name = inv.command;
		const matches = this.hub.listCommands().filter((command) => command.name.toLowerCase() === name);
		if (matches.length) {
			const target = matches[0];
			const rest = inv.args.trim();
			const invocation = `/${target.name}${rest ? ` ${rest}` : ""}`;
			this.hub.noteTelegramInput(invocation);
			this.hub.sendToPi(invocation, { expandPromptTemplates: true });
			await this.say(chatId, `▶️ ${inlineCode(`/${target.name}`)} · ${target.source}`);
			return;
		}
		if (TERMINAL_ONLY.includes(name)) {
			await this.say(chatId, (lang) => `ℹ️ /${name} ${pick(lang, "은 pi 터미널 전용이에요.", "is pi-terminal only.")} ${pick(lang, "Telegram에서는", "On Telegram you can use")} ${inlineCode("/model /thinking /compact /new /resume /fork /tree /rename /reload /bash /usage")}.`);
			return;
		}
		const invocation = inv.raw.trim();
		this.hub.noteTelegramInput(invocation);
		this.hub.sendToPi(invocation, { expandPromptTemplates: true });
		await this.say(chatId, (lang) => `❓ ${pick(lang, "알려진 명령이 아니어서 pi에 그대로 보냈어요. 프롬프트 템플릿·스킬이면 동작해요.", "not a known command, so it went to pi as written — a prompt template or skill will still run it.")} ${pick(lang, "목록", "list")}: ${inlineCode("/commands")}`);
	}

	// ------------------------------------------------------------------ lists

	private listRender(spec: ListSpec): ListRender {
		switch (spec.list) {
			case "model": {
				const models = spec.args.trim() ? this.hub.searchModels(spec.args, 80) : this.hub.listModels();
				const local = models.filter((model) => model.local).length;
				return {
					title: (lang) => `<b>model</b> · ${models.length}${spec.args ? ` "${escapeHtml(spec.args.trim())}"${models.length >= 80 ? ` ✂️ ${pick(lang, "일부만", "partial")}` : ""}` : ` ${pick(lang, "관련", "matching")}`}${local ? ` · ${pick(lang, `${local}개 로컬`, `${local} local`)} 🏠` : ""}`,
					note: (lang) => `🏠 = ${pick(lang, "내 머신", "my machine")} · 🔑 = ${pick(lang, "pi에 이 provider의 인증이 없어요", "pi has no credential for this provider")}${this.hub.modelProviders().reduce((sum, entry) => sum + entry.count, 0) > models.length + 10 ? ` · 🔎 ${pick(lang, `pi가 아는 모델은 ${this.hub.modelProviders().reduce((sum, entry) => sum + entry.count, 0)}개 — ${inlineCode("/model <검색어>")}나 ${inlineCode("provider/id")}로 직접 지정`, `pi knows ${this.hub.modelProviders().reduce((sum, entry) => sum + entry.count, 0)} models — name one with ${inlineCode("/model <search>")} or ${inlineCode("provider/id")}`)}` : ""}`,
					perPage: 12,
					columns: 1,
					items: models.map((model) => ({
						label: clip(`${model.current ? "● " : "  "}${model.local ? "🏠 " : ""}${model.needsAuth ? "🔑 " : ""}${clip(model.name, 26)} · ${model.provider}`, 62),
						kind: "model:pick" as CallbackActionKind,
						value: model.key,
					})),
				};
			}
			case "model:providers": {
				const providers = this.hub.modelProviders();
				return {
					title: (lang) => `<b>model</b> 🗂 · ${providers.reduce((sum, entry) => sum + entry.count, 0)} · ${pick(lang, "provider를 고르세요", "pick a provider")}`,
					note: (lang) => pick(lang, `${inlineCode("/model <검색어>")} · ${inlineCode("/model <provider/id>")}`, `${inlineCode("/model <search>")} or ${inlineCode("/model <provider/id>")} also work typed directly`),
					perPage: 12,
					columns: 1,
					items: providers.map((entry) => ({
						label: clip(`${entry.local ? "🏠 " : ""}${entry.needsAuth ? "🔑 " : ""}${clip(entry.provider, 28)} · ${entry.count}`, 62),
						kind: "model:provider" as CallbackActionKind,
						value: entry.provider,
					})),
				};
			}
			case "resume": {
				const sessions = this.hub.listSessionFiles(60);
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? sessions.filter((entry) => entry.label.toLowerCase().includes(query) || (entry.projectLabel ?? "").toLowerCase().includes(query)) : sessions;
				return {
					title: (lang) => `<b>resume</b> · ${filtered.length} ${pick(lang, "세션 (최신순 · 이 프로젝트 먼저)", "sessions (newest first · this project first)")}`,
					perPage: 8,
					columns: 1,
					items: filtered.map((entry) => ({
						label: clip(`${entry.current ? "● " : "  "}${clip(entry.label, 40)}${entry.projectLabel ? ` ·${entry.projectLabel}` : ""}`, 62),
						kind: "resume:pick" as CallbackActionKind,
						value: entry.path,
					})),
				};
			}
			case "fork": {
				const prompts = this.hub.listPromptEntries(40);
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? prompts.filter((entry) => entry.text.toLowerCase().includes(query)) : prompts;
				return {
					title: (lang) => `<b>fork</b> · ${pick(lang, "지점을 선택하세요", "pick a starting point")}`,
					perPage: 8,
					columns: 1,
					note: L("선택하면 그 프롬프트 시점부터 새 세션이 시작돼요.", "picking one starts a new session from that prompt"),
					items: filtered.map((entry) => ({ label: `↪ ${clip(entry.text, 56)}`, kind: "fork:pick" as CallbackActionKind, value: entry.entryId })),
				};
			}
			case "tree": {
				const entries = this.hub.listTreeEntries(60);
				return {
					title: (lang) => `<b>tree</b> · ${pick(lang, "이동할 지점", "where to jump to")}`,
					perPage: 8,
					columns: 1,
					note: L("요약 없이 해당 지점으로 이동합니다.", "moves to that point without summarising"),
					items: entries.map((entry) => ({ label: `${entry.current ? "● " : "  "}${clip(entry.label, 56)}`, kind: "tree:pick" as CallbackActionKind, value: entry.entryId })),
				};
			}
			case "commands": {
				const all = this.hub.listCommands();
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? all.filter((command) => `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query)) : all;
				return {
					title: `<b>pi commands</b> · ${filtered.length} (extension · template · skill)`,
					perPage: 8,
					columns: 1,
					items: filtered.map((command) => ({
						label: clip(`/${clip(command.name, 34)}${command.description ? ` — ${clip(command.description, 24)}` : ""}`, 62),
						kind: "commands:pick" as CallbackActionKind,
						value: command.name,
					})),
				};
			}
			case "skills": {
				const skills = this.hub.listCommands().filter((command) => command.source === "skill");
				const query = spec.args.trim().toLowerCase();
				const filtered = query ? skills.filter((skill) => skill.name.toLowerCase().includes(query)) : skills;
				return {
					title: `<b>skills</b> · ${filtered.length}`,
					perPage: 8,
					columns: 1,
					items: filtered.map((skill) => ({ label: clip(skill.name, 40), kind: "commands:pick" as CallbackActionKind, value: skill.name })),
				};
			}
			case "tools": {
				const tools = this.hub.listTools();
				return {
					title: `<b>tools</b> · ${tools.filter((tool) => tool.active).length}/${tools.length} active`,
					note: L("누르면 바로 적용돼요.", "a tap applies it right away"),
					perPage: 16,
					columns: 2,
					items: tools.map((tool) => ({ label: `${tool.active ? "✅" : "⬜"} ${clip(tool.name, 20)}`, kind: "tools:toggle" as CallbackActionKind, value: tool.name })),
				};
			}
		}
	}

	private async renderList(chatId: number, spec: ListSpec, editMessageId?: number): Promise<void> {
		const view = this.listRender(spec);
		if (!view.items.length) {
			await this.say(chatId, (lang) => `⚠️ ${pick(lang, "항목이 없어요", "nothing to show")}${spec.args ? `: ${inlineCode(spec.args)}` : ""}`);
			return;
		}
		const pages = Math.max(1, Math.ceil(view.items.length / view.perPage));
		const page = Math.min(spec.page, pages - 1);
		const slice = view.items.slice(page * view.perPage, (page + 1) * view.perPage);
		const rows: TgInlineKeyboardButton[][] = [];
		for (let index = 0; index < slice.length; index += view.columns) {
			rows.push(
				slice.slice(index, index + view.columns).map((item) => ({
					text: item.label,
					callback_data: this.hub.createToken({ kind: item.kind, value: item.value }, chatId),
				})),
			);
		}
		if (pages > 1) {
			const nav: TgInlineKeyboardButton[] = [];
			if (page > 0) nav.push({ text: "◀️", callback_data: this.hub.createToken({ kind: "list:page", blob: { ...spec, page: page - 1 } }, chatId) });
			nav.push({ text: `${page + 1}/${pages}`, callback_data: this.hub.createToken({ kind: "noop" }, chatId) });
			if (page < pages - 1) nav.push({ text: "▶️", callback_data: this.hub.createToken({ kind: "list:page", blob: { ...spec, page: page + 1 } }, chatId) });
			rows.push(nav);
		}
		const text: Localized = (lang) => {
			const note = render(view.note ?? "", lang);
			return `${render(view.title, lang)}\n${note ? `<i>${note}</i>\n` : ""}`;
		};
		if (editMessageId) {
			const ok = await this.hub.editKeyboard(chatId, editMessageId, render(text, this.hub.lang(chatId)), rows);
			if (!ok) await this.say(chatId, text, { keyboard: rows });
			return;
		}
		await this.say(chatId, text, { keyboard: rows });
	}

	// -------------------------------------------------------------- callbacks

	async handleCallback(chatId: number, messageId: number | undefined, entry: CallbackEntry): Promise<CallbackResult> {
		const action = entry.action;
		switch (action.kind) {
			case "model:pick": {
				// the key came from a search over the whole registry, so it may not be in the curated list
				await this.applyModelRef(chatId, action.value ?? "");
				return { toast: action.value ?? "" };
			}
			case "model:provider":
				await this.renderList(chatId, { list: "model", args: action.value ?? "", page: 0 });
				return { toast: action.value ?? "" };
			case "thinking:pick": {
				const result = this.hub.setThinkingLevel(action.value ?? "off");
				return { toast: result.ok ? `thinking: ${action.value}` : pick(this.hub.lang(chatId), "변경 실패", "change failed"), showAlert: !result.ok };
			}
			case "resume:pick": {
				if (!action.value) return { toast: pick(this.hub.lang(chatId), "세션을 찾을 수 없어요", "that session is gone"), showAlert: true };
				await this.say(chatId, L("♻️ 세션 불러오는 중…", "♻️ loading that session…"));
				const notice = this.hub.notifyAfterRestart((lang) => `♻️ <b>${pick(lang, "세션 전환", "session switched")}</b> · ${inlineCode(this.hub.sessionInfo().id)}`);
				try {
					await this.hub.withCommandContext(async (ctx) => {
						await ctx.switchSession(action.value!);
					});
					this.hub.clearPendingNotice(notice);
					await this.say(chatId, L("✅ 세션 전환 요청이 처리됐어요.", "✅ the session switch was handled."));
				} catch (error) {
					this.hub.clearPendingNotice(notice);
					await this.quietSay(chatId, (lang) => `⚠️ resume ${pick(lang, "실패", "failed")}: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "resumed" };
			}
			case "fork:pick": {
				if (!action.value) return { toast: pick(this.hub.lang(chatId), "항목을 찾을 수 없어요", "that entry is gone"), showAlert: true };
				const notice = this.hub.notifyAfterRestart(L("🌱 <b>fork</b> 완료 — 그 지점부터 새 세션이 이어져요.", "🌱 <b>fork</b> done — the session continues from that point."));
				try {
					await this.hub.withCommandContext(async (ctx) => {
						await ctx.fork(action.value!, { position: "at" });
					});
					this.hub.clearPendingNotice(notice);
					await this.say(chatId, L("🌱 fork 완료 — 새 세션에서 이어가요.", "🌱 fork done — a new session continues from there."));
				} catch (error) {
					this.hub.clearPendingNotice(notice);
					await this.quietSay(chatId, (lang) => `⚠️ fork ${pick(lang, "실패", "failed")}: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "forked" };
			}
			case "tree:pick": {
				if (!action.value) return { toast: pick(this.hub.lang(chatId), "항목을 찾을 수 없어요", "that entry is gone"), showAlert: true };
				try {
					tgDebug("tree:pick", action.value);
					// Moving in the tree can make pi summarize branches, and pi refuses prompts while it does.
					this.hub.setContextBusy(true, "tree navigation");
					try {
						await this.hub.withCommandContext(async (ctx) => {
							tgDebug("tree: calling navigateTree");
							const result = await ctx.navigateTree(action.value!, { summarize: false });
							tgDebug("tree: navigateTree returned", result);
						});
					} finally {
						this.hub.setContextBusy(false, "tree navigation");
					}
					tgDebug("tree: context action done, confirming in chat");
					await this.say(chatId, L("🌳 이동 완료.", "🌳 moved."));
					tgDebug("tree: confirmation sent");
				} catch (error) {
					tgDebug("tree:pick failed", errorMessage(error));
					await this.quietSay(chatId, (lang) => `⚠️ tree ${pick(lang, "이동 실패", "move failed")}: ${escapeHtml(safeError(error))}`);
				}
				return { toast: "moved" };
			}
			case "tools:toggle": {
				const tools = this.hub.listTools();
				const active = new Set(tools.filter((tool) => tool.active).map((tool) => tool.name));
				const name = action.value ?? "";
				if (active.has(name)) active.delete(name);
				else active.add(name);
				this.hub.setActiveTools([...active]);
				return { toast: `${name}: ${active.has(name) ? "on" : "off"}` };
			}
			case "tools:reset": {
				this.hub.setActiveTools(this.hub.listTools().map((tool) => tool.name).filter((name) => DEFAULT_TOOLS.includes(name)));
				return { toast: "default tools" };
			}
			case "commands:pick": {
				if (!action.value) return { toast: pick(this.hub.lang(chatId), "명령어를 찾을 수 없어요", "that command is gone"), showAlert: true };
				this.hub.noteTelegramInput(`/${action.value}`);
				this.hub.sendToPi(`/${action.value}`, { expandPromptTemplates: true });
				return { toast: `/${action.value}` };
			}
			case "list:page": {
				const spec = action.blob as ListSpec;
				if (!spec?.list) return { toast: pick(this.hub.lang(chatId), "목록이 만료됐어요", "this list has expired"), showAlert: true };
				await this.renderList(chatId, spec, messageId);
				return { toast: "" };
			}
			case "menu:open": {
				const value = action.value ?? "";
				const [command, ...rest] = value.split(/\s+/);
				await this.handle({ chatId, userId: 0, command: command.toLowerCase(), args: rest.join(" "), raw: value });
				return { toast: command };
			}
			case "chat:unpair": {
				const target = Number(action.value ?? "");
				if (!Number.isFinite(target)) return { toast: pick(this.hub.lang(chatId), "잘못된 채팅 id", "bad chat id"), showAlert: true };
				const removed = this.hub.unpairChat(target);
				return { toast: removed ? `revoked ${target}` : pick(this.hub.lang(chatId), "이미 없음", "already gone"), showAlert: !removed };
			}
			case "noop":
				return { toast: "" };
			default:
				return { toast: "" };
		}
	}

	// ----------------------------------------------------------------- layout

	/** Reply, tolerating a bridge that already went away with a replaced pi session. */
	private async quietSay(chatId: number, html: Localized): Promise<void> {
		try {
			await this.say(chatId, html);
		} catch {
			/* the pi session (and this bridge instance) was replaced underneath us */
		}
	}

	/** Command replies are built as Telegram HTML, so they skip markdown conversion. */
	private async say(chatId: number, html: Localized, options?: SendOptions): Promise<void> {
		await this.hub.send(chatId, html, { markdown: false, ...options });
	}

	private menuButton(chatId: number, text: string, commandAndArgs: string): TgInlineKeyboardButton {
		return { text, callback_data: this.hub.createToken({ kind: "menu:open", value: commandAndArgs }, chatId) };
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Error text for a chat window. pi errors quote provider payloads, and providers quote the
 * credential the call carried, so nothing raw from an error ever goes to a phone.
 */
export function safeError(error: unknown): string {
	return redactSecrets(errorMessage(error));
}
