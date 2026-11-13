/**
 * Goal-driven runs: interop with `pi-goal-x`.
 *
 * A goal makes pi work unattended for a long time, and everything pi-goal-x says about it lives in
 * the terminal — its own commands, its own dialogs, its own files under `.pi/goals`. On a phone you
 * cannot tell what pi is chasing, how far it got, or whether it quietly paused.
 *
 * So we read only what pi-goal-x already puts on the session record: the goal record its task tools
 * hand back in a tool result's `details`, and its `pi-goal-focus` entries. We never read its files
 * and never call its internals, and every shape is treated as unknown — another extension's record
 * layout is not our contract, and a rename there must not break a bridge here.
 */
import { escapeHtml, formatCount, formatDuration, inlineCode, truncate } from "./format.ts";

/** pi-goal-x's focus entry (`pi.appendEntry("pi-goal-focus", …)`); read-only for us. */
export const GOAL_FOCUS_ENTRY = "pi-goal-focus";
/** Older pi-goal-x releases persisted the whole goal record here; current ones do not, but a
 *  session restored from one still deserves a goal card. */
export const GOAL_STATE_ENTRY = "pi-goal-state";

export interface GoalSnapshot {
	id: string;
	objective: string;
	status: string;
	autoContinue: boolean;
	ordered: boolean;
	tokensUsed: number;
	activeSeconds: number;
	tokenBudget?: number;
	tasksDone: number;
	tasksTotal: number;
	currentTask?: string;
	pauseReason?: string;
	pauseAction?: string;
	stopReason?: string;
	updatedAt?: string;
	revision?: number;
}

export interface FocusState {
	goalId: string | null;
	reason?: string;
}

export class GoalView {
	private snapshot: GoalSnapshot | undefined;
	private focus: FocusState | undefined;
	/** What we last announced, so checkpoints do not become chat spam. */
	private reportedKey = "";
	private lastAnnouncedAt = 0;

	current(): GoalSnapshot | undefined {
		return this.snapshot;
	}

	focusState(): FocusState | undefined {
		return this.focus;
	}

	reset(): void {
		this.snapshot = undefined;
		this.focus = undefined;
		this.reportedKey = "";
	}

	/**
	 * Fold a tool result in. Returns chat HTML when the change is worth telling the phone about —
	 * a new goal, a status change, or visible task progress. Nothing else is announced.
	 */
	observeToolResult(result: unknown): string | undefined {
		const goal = findGoal(result);
		if (!goal) return undefined;
		return this.announce(goal);
	}

	/** Rebuild what the last session knew, so `/tg goal` answers after `/resume` and after `/fork`. */
	restore(entries: readonly unknown[]): GoalSnapshot | undefined {
		this.snapshot = undefined;
		this.focus = undefined;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = asRecord(entries[index]);
			if (!entry) continue;
			if (entry.type === "custom") {
				if (entry.customType === GOAL_FOCUS_ENTRY && !this.focus) {
					const focus = readFocus(entry.data);
					if (focus) this.focus = focus;
				}
				// A pi-goal-x release that is old enough to have written this entry is old enough to
				// have left nothing else behind, so the record inside it is all we get.
				if (entry.customType === GOAL_STATE_ENTRY && !this.snapshot) {
					const goal = findGoal(entry.data);
					if (goal) this.snapshot = goal;
				}
			}
			if (entry.type === "message" && !this.snapshot) {
				const goal = findGoal(entry.message);
				if (goal) this.snapshot = goal;
			}
			if (this.snapshot && this.focus) break;
		}
		// A restored goal is not news: seed the announcement key without sending anything.
		this.reportedKey = this.snapshot ? announceKey(this.snapshot) : "";
		this.lastAnnouncedAt = 0;
		return this.snapshot;
	}

	private announce(goal: GoalSnapshot): string | undefined {
		const previous = this.snapshot;
		this.snapshot = goal;
		const key = announceKey(goal);
		if (key === this.reportedKey) return undefined;
		this.reportedKey = key;
		const news = !previous
			? "시작"
			: previous.id !== goal.id
				? "새 목표"
				: previous.status !== goal.status
					? "상태 변경"
					: previous.tasksDone !== goal.tasksDone
						? "진행"
						: undefined;
		if (!news) return undefined; // bookkeeping-only mutation: the phone does not need it
		if (news === "진행" && Date.now() - this.lastAnnouncedAt < 20_000) return undefined;
		this.lastAnnouncedAt = Date.now();
		return goalLineHtml(goal, news);
	}
}

// ------------------------------------------------------------------ payload reading

/** Statuses pi-goal-x uses; unknown statuses still render, they just keep their own name. */
const STATUS_ICON: Record<string, string> = {
	active: "▶️",
	paused: "⏸️",
	blocked: "🚧",
	budget_limited: "💸",
	complete: "✅",
};

export function goalStatusLabel(status: string): string {
	return `${STATUS_ICON[status] ?? "🎯"} ${escapeHtml(status)}`;
}

/** One compact line for the mirror. */
export function goalLineHtml(goal: GoalSnapshot, news: string): string {
	const usage = [`${formatCount(goal.tokensUsed)} tok`, goal.tokenBudget ? `/ ${formatCount(goal.tokenBudget)}` : undefined, goal.activeSeconds ? formatDuration(goal.activeSeconds * 1000) : undefined]
		.filter(Boolean)
		.join(" ");
	const parts = [`🎯 <b>goal</b> <i>(${news})</i> ${goalStatusLabel(goal.status)}${goal.autoContinue ? " <i>· 자동 계속</i>" : ""}`];
	if (goal.tasksTotal) parts.push(`작업 ${goal.tasksDone}/${goal.tasksTotal}`);
	if (goal.pauseReason) parts.push(`⏸️ ${escapeHtml(truncate(goal.pauseReason, 200))}`);
	parts.push(`<i>${escapeHtml(truncate(goal.objective, 300))}</i>`);
	parts.push(`<i>${escapeHtml(usage)}</i>`);
	return parts.join("\n");
}

/** The `/tg goal` card. */
export function goalCardHtml(goal: GoalSnapshot | undefined, focus?: FocusState): string {
	if (!goal) {
		const focusNote = focus ? `\n현재 focused goal: ${inlineCode(focus.goalId ?? "없음")}${focus.reason ? ` (${escapeHtml(focus.reason)})` : ""}` : "";
		return [
			`🎯 <b>goal</b>`,
			`이 세션에서 추적 중인 goal이 없어요. pi-goal-x가 설치돼 있으면 ${inlineCode("/goal-direct <목표>")}로 바로 시작할 수 있어요.`,
			`pi-goal-x 명령은 그대로 쓸 수 있어요: ${inlineCode("/goal-status · /goal-pause · /goal-resume · /goal-clear · /goal-list")}`,
			`<i>확인 대화상자는 pi 터미널에 뜨니, 원격에서는 확인이 필요한 명령(예: /goal-clear)을 쓸 때 조심하세요.</i>`,
			focusNote,
		]
			.filter(Boolean)
			.join("\n");
	}
	const usage = [
		`${formatCount(goal.tokensUsed)} tokens`,
		goal.tokenBudget ? `예산 ${formatCount(goal.tokenBudget)}` : undefined,
		`활동 ${formatDuration(goal.activeSeconds * 1000)}`,
	]
		.filter(Boolean)
		.join(" · ");
	const lines = [
		`🎯 <b>goal</b> ${goalStatusLabel(goal.status)}${goal.autoContinue ? " <i>· 자동 계속</i>" : ""}${goal.ordered ? " <i>· 순차</i>" : ""}`,
		`id ${inlineCode(truncate(goal.id, 40))} · rev ${inlineCode(String(goal.revision ?? 0))}${goal.updatedAt ? ` · ${escapeHtml(goal.updatedAt.slice(0, 19).replace("T", " "))}` : ""}`,
		`<b>목표</b>\n${escapeHtml(truncate(goal.objective, 1200))}`,
		`사용량 ${escapeHtml(usage)}`,
	];
	if (goal.tasksTotal) {
		lines.push(`작업 ${goal.tasksDone}/${goal.tasksTotal}${goal.currentTask ? ` · 진행 중: ${inlineCode(truncate(goal.currentTask, 40))}` : ""}`);
	}
	if (goal.pauseReason) lines.push(`⏸️ 중단 사유: ${escapeHtml(truncate(goal.pauseReason, 400))}${goal.pauseAction ? `\n권장 조치: ${escapeHtml(truncate(goal.pauseAction, 300))}` : ""}`);
	if (goal.stopReason) lines.push(`stop reason: ${inlineCode(goal.stopReason)}`);
	lines.push(`<i>pi에서 ${inlineCode("/goal-pause · /goal-resume · /goal-tweak · /goal-clear")} — Telegram에서 보내도 동작하지만 확인 상자는 터미널에 떠요.</i>`);
	return lines.join("\n");
}

/** Dig a goal record out of a tool result / session message, looking only where pi-goal-x puts it. */
function findGoal(value: unknown, depth = 0): GoalSnapshot | undefined {
	if (depth > 3) return undefined;
	const record = asRecord(value);
	if (!record) return undefined;
	const direct = readGoal(record);
	if (direct) return direct;
	for (const key of ["details", "goal", "state", "result", "message"]) {
		const nested = record[key];
		if (nested && typeof nested === "object") {
			const found = findGoal(nested, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

function readGoal(record: Record<string, unknown>): GoalSnapshot | undefined {
	const id = stringOr(record.id);
	const objective = stringOr(record.objective);
	const status = stringOr(record.status);
	// All three are required: this is how we recognise a goal record without naming the extension.
	if (!id || !objective || !status) return undefined;
	const usage = asRecord(record.usage);
	const taskList = asRecord(record.taskList);
	const tasks = Array.isArray(taskList?.tasks) ? taskList.tasks : [];
	const currentTaskId = stringOr(record.currentTaskId);
	return {
		id,
		objective,
		status,
		autoContinue: record.autoContinue === true,
		ordered: record.sisyphus === true,
		tokensUsed: numberOr(usage?.tokensUsed),
		activeSeconds: numberOr(usage?.activeSeconds),
		...(numberOr(record.tokenBudget) > 0 ? { tokenBudget: numberOr(record.tokenBudget) } : {}),
		tasksDone: tasks.filter((task) => asRecord(task)?.status === "complete").length,
		tasksTotal: tasks.length,
		...(currentTaskId ? { currentTask: currentTaskId } : {}),
		...(stringOr(record.pauseReason) ? { pauseReason: stringOr(record.pauseReason) as string } : {}),
		...(stringOr(record.pauseSuggestedAction) ? { pauseAction: stringOr(record.pauseSuggestedAction) as string } : {}),
		...(stringOr(record.stopReason) ? { stopReason: stringOr(record.stopReason) as string } : {}),
		...(stringOr(record.updatedAt) ? { updatedAt: stringOr(record.updatedAt) as string } : {}),
		revision: Number.isFinite(record.revision) ? Number(record.revision) : undefined,
	};
}

function readFocus(data: unknown): FocusState | undefined {
	const record = asRecord(data);
	if (!record || !("focusedGoalId" in record)) return undefined;
	const goalId = record.focusedGoalId;
	return {
		goalId: typeof goalId === "string" ? goalId : null,
		...(stringOr(record.reason) ? { reason: stringOr(record.reason) as string } : {}),
	};
}

function announceKey(goal: GoalSnapshot): string {
	return `${goal.id}|${goal.status}|${goal.tasksDone}/${goal.tasksTotal}|${goal.autoContinue}|${goal.pauseReason ?? ""}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringOr(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOr(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
