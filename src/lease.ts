/**
 * Who owns the Telegram connection.
 *
 * One bot token allows one long poller. Pi does not know that: open a second session (another
 * project, another terminal, a `/reload`) and both extensions poll the same token, Telegram answers
 * 409 to one of them, and the operator watches that warning scroll by forever with no way to tell
 * which window is even at fault.
 *
 * So the sessions settle it in a file next to the token. Whoever holds the lease polls; everyone
 * else opens quiet and says so in its own terminal. Every live session also leaves a heartbeat line,
 * which is what makes "which window has it?" an answerable question.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/** A live session renews its lease this often. */
export const LEASE_HEARTBEAT_MS = 10_000;
/**
 * Silence this long means the window is gone. Generous on purpose: a window that is merely busy, or a
 * laptop that was closed for a minute, must not lose the bridge the person is actually using.
 */
export const LEASE_TTL_MS = 120_000;
/** After somebody turns a session off on purpose, wait this long before a waiting session takes over. */
export const LEASE_RELEASE_HOLD_MS = 5 * 60_000;

/** Which pi window this belongs to — one window can replace its session (/new, /reload) and stay us. */
export function windowId(pid: number, host: string): string {
	return `pi-${pid}@${host}`;
}

export interface BridgeOwner {
	/** The window: pid + host. Two windows never share it, one window's replacement sessions always do. */
	owner: string;
	/** Random per bridge instance, so a window's outgoing session can never unlock what its successor holds. */
	token: string;
	pid: number;
	host: string;
	cwd: string;
	/** Session title when pi has one, otherwise its file name. Handy with four windows open. */
	label: string;
	since: number;
	heartbeat: number;
}

export interface BridgeSession extends BridgeOwner {
	connected: boolean;
	holding: boolean;
}

export interface BridgeState {
	/** The session currently allowed to poll. */
	bridge: BridgeOwner | null;
	/** Every session still breathing, whether it holds the bridge or not. */
	sessions: BridgeSession[];
	/**
	 * Set when a holder let go. `shutdown` means the window closed (the phone should not go dark, so a
	 * waiting session may take over); an explicit /telegram off is respected until the hold expires.
	 */
	released?: { by: string; pid: number; host: string; at: number; shutdown: boolean };
}

export function emptyState(): BridgeState {
	return { bridge: null, sessions: [] };
}

/** A lease is only worth as much as the process behind it. */
export function holderAlive(owner: BridgeOwner, now = Date.now()): boolean {
	if (now - owner.heartbeat > LEASE_TTL_MS) return false;
	// Same machine: a process the OS says does not exist is gone. Anything else — including "you are not
	// allowed to look at that process" — means it is running, and guessing otherwise would let one window
	// steal the phone out of another person's session.
	if (owner.host === hostname()) return !processMissing(owner.pid);
	// Another machine — nothing local to check, so the heartbeat is all there is.
	return true;
}

/** ESRCH is the only answer that proves a process is gone. EPERM means it is there, just private. */
export function processMissing(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export function readState(path: string): BridgeState {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeState>;
		const sessions = Array.isArray(raw.sessions)
			? raw.sessions
					.map((s) => ({
						owner: String(s?.owner ?? ""),
						token: String(s?.token ?? ""),
						pid: Number(s?.pid ?? 0),
						host: String(s?.host ?? ""),
						cwd: String(s?.cwd ?? ""),
						label: String(s?.label ?? ""),
						since: Number(s?.since ?? 0),
						heartbeat: Number(s?.heartbeat ?? 0),
						connected: Boolean(s?.connected),
						holding: Boolean(s?.holding),
					}))
					.filter((s) => s.owner)
			: [];
		const bridge = raw.bridge && raw.bridge.owner ? (raw.bridge as BridgeOwner) : null;
		return { bridge, sessions, released: raw.released };
	} catch {
		return emptyState();
	}
}

/**
 * Claim the bridge, or explain who has it. `force` takes it off another window — the loser finds out
 * from telegram's own 409, or from the lease no longer naming it, and stands down.
 */
export function claim(path: string, me: BridgeOwner, force = false): { ok: boolean; holder: BridgeOwner | null } {
	const state = readState(path);
	const holder = state.bridge;
	// Same window (pi replacing its own session) is never a rival; a second pi process is, even on this
	// machine. The window identity says which is which, so /reload reconnects without a fight.
	const rival = holder && !sameWindow(holder, me);
	if (rival && holderAlive(holder)) {
		if (!force) return { ok: false, holder };
	}
	const now = Date.now();
	me.since = holder && sameWindow(holder, me) ? holder.since : now;
	me.heartbeat = now;
	const sessions = state.sessions.filter((s) => !sameWindow(s, me) && now - s.heartbeat < LEASE_TTL_MS);
	sessions.push({ ...me, connected: true, holding: true });
	writeState(path, { bridge: me, sessions, released: undefined });
	return { ok: true, holder: rival ? holder : null };
}

/** Let go — `shutdown: false` means a human turned this session off, which others should respect. */
export function release(path: string, me: BridgeOwner, shutdown: boolean): void {
	const state = readState(path);
	const now = Date.now();
	// Only our own record: when pi replaces a session, the outgoing instance must not release what the
	// incoming one has already claimed a moment earlier.
	const bridge = state.bridge && state.bridge.token === me.token ? null : state.bridge;
	writeState(path, {
		bridge,
		sessions: state.sessions.filter((s) => !sameWindow(s, me) && now - s.heartbeat < LEASE_TTL_MS),
		released: { by: me.owner, pid: me.pid, host: me.host, at: now, shutdown },
	});
}

/**
 * Keep the heartbeat line honest, about the bridge and about this session's own place in the list.
 * Returns whether the caller still owns the bridge: someone may have taken it while we were busy.
 */
export function beat(
	path: string,
	me: BridgeOwner,
	connected: boolean,
): { mine: boolean; holder: BridgeOwner | null; gone: BridgeOwner | null } {
	const state = readState(path);
	const now = Date.now();
	const recorded = state.bridge ?? null;
	const live = recorded && holderAlive(recorded, now) ? recorded : null;
	const mine = live ? live.token === me.token : false;
	me.heartbeat = now;
	const sessions = state.sessions.filter((s) => !sameWindow(s, me) && now - s.heartbeat < LEASE_TTL_MS);
	sessions.push({ ...me, connected, holding: mine });
	writeState(path, { bridge: live, sessions, released: state.released });
	// `gone` matters: a lease held by something that is no longer running is not a rival, it is debris.
	return { mine, holder: live, gone: recorded && !live ? recorded : null };
}

/** Free to take? A live holder means no; a session that died mid-session means yes. */
export function available(path: string): { free: boolean; holder: BridgeOwner | null } {
	const holder = readState(path).bridge;
	if (holder && holder.owner && holderAlive(holder)) return { free: false, holder };
	return { free: true, holder: holder ?? null };
}

/**
 * May a session that is starting up take the bridge? Yes when nobody is holding it, or the holder is
 * clearly gone. No when a human typed /telegram off: that choice stands until the hold expires.
 *
 * Note this is only ever asked by a *starting* session. A window that already stood down never asks
 * again — if the holder closes, a waiting or switched-off window stays exactly as it was, because the
 * person decides which window talks to their phone (`/telegram on`).
 */
export function shouldTakeOver(path: string, me: BridgeOwner, now = Date.now()): boolean {
	const state = readState(path);
	const holder = state.bridge;
	if (holder && !sameWindow(holder, me) && holderAlive(holder, now)) return false;
	if (holder && sameWindow(holder, me)) return true; // ours, or a stale record of ours
	const released = state.released;
	if (!holder && released && !released.shutdown && now - released.at < LEASE_RELEASE_HOLD_MS) {
		// The hold protects a choice a person made in a window that is still open. It means nothing once
		// that window is gone — otherwise a crash mid-`off` leaves the phone unreachable for five minutes.
		if (released.by !== me.owner) {
			const releaser = { owner: released.by, token: "", pid: released.pid ?? 0, host: released.host ?? "", cwd: "", label: "", since: released.at, heartbeat: released.at };
			if (released.host && !sameWindow(releaser, me) && !holderAlive(releaser, now)) return true;
			return false;
		}
		return true;
	}
	// Nothing holds it and nobody is being waited out — the bridge is free, and a fresh session
	// that finds no lease file at all must still connect.
	return true;
}

function writeState(path: string, state: BridgeState): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Another window writes this file too; swap it in rather than rewriting it in place.
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, "\t"), { mode: 0o600 });
	renameSync(tmp, path);
}

/** The same pi window, across a /new, /reload or /fork that rebuilt the extension. */
export function sameWindow(a: BridgeOwner, b: BridgeOwner): boolean {
	if (!a.host || !b.host) return a.owner === b.owner;
	return a.host === b.host && a.pid === b.pid;
}

export function describeOwner(owner: BridgeOwner): string {
	const age = Math.round((Date.now() - owner.since) / 1000);
	return `${owner.label || basename(owner.cwd) || "pi"} · pid ${owner.pid} · ${owner.host} · ${age}s`;
}
