// Stops tasks agents never closed: `session-dead` when the owning session is gone, `idle` when
// untouched for `idleMs`. Closing goes through `BrowserService.stop` so teardown stays on one path,
// and never touches a tab outside `task.tabs` or the browser process itself.
import { isPidAlive, isSessionIdLiveOnProcessTable } from '../runtime/session.js';
import { listPidSessionEntries, sessionIdFromLivePid, type PidSessionEntry } from '../runtime/session.js';
import { parseConnectionKey, type ReapResult, type ReapedTask, type Task } from './types.js';

/** Default idle window before an untouched task is reaped. */
export const DEFAULT_IDLE_MS = 30 * 60_000;

/** The slice of `BrowserService` the reaper needs; structural, which keeps this off its import cycle. */
export interface ReapableService {
  listTasks(): Array<{ profile: string; task: Task }>;
  recordStatus(taskName: string): Promise<{ recording: boolean }>;
  stop(taskName: string): Promise<{ ok: boolean; profile?: string }>;
}

/** Liveness sources; the defaults are the real launch registry and the real process table. */
export interface ReapDeps {
  listEntries?: () => PidSessionEntry[];
  pidAlive?: (pid: number, startedAtMs?: number) => boolean;
  sessionIdOfPid?: (pid: number) => string | undefined;
  sessionLiveOnProcessTable?: (sessionId: string) => Promise<boolean>;
}

export interface ReapOptions {
  /**
   * Idle window in ms, default {@link DEFAULT_IDLE_MS}. `null` turns idle reaping off
   * (`browser.task-idle-minutes=0`); a `0` throws, since it is likelier a bug than intent.
   */
  idleMs?: number | null;
  /** Clock, injectable for tests. Default `Date.now()`. */
  now?: number;
  /** Report what would be closed without closing anything. */
  dryRun?: boolean;
  deps?: ReapDeps;
}

export interface LiveIdentities {
  sessions: Set<string>;
  launches: Set<string>;
}

/**
 * Session and launch ids of live registry pids, checked with their start time so a recycled pid
 * does not count. An entry without a `sessionId` uses the live process's `--session-id` argv.
 */
export function resolveLiveIdentities(deps: ReapDeps = {}): LiveIdentities {
  const listEntries = deps.listEntries ?? listPidSessionEntries;
  const alive = deps.pidAlive ?? isPidAlive;
  const sessionIdOf = deps.sessionIdOfPid ?? sessionIdFromLivePid;

  const sessions = new Set<string>();
  const launches = new Set<string>();
  for (const entry of listEntries()) {
    if (!alive(entry.pid, entry.startedAtMs)) continue;
    const sessionId = entry.sessionId ?? sessionIdOf(entry.pid);
    if (sessionId) sessions.add(sessionId);
    if (entry.launchId) launches.add(entry.launchId);
  }
  return { sessions, launches };
}

/**
 * True only when the owner provably is gone: its `sessionId` is in neither the registry nor the
 * process table. A `launchId`, witnessed only by the unreliable registry, proves life, never death.
 */
export async function taskOwnerIsGone(
  task: Task,
  live: LiveIdentities,
  deps: ReapDeps = {},
): Promise<boolean> {
  if (!task.sessionId || task.fleetRemote) return false;

  if (task.launchId && live.launches.has(task.launchId)) return false;
  if (live.sessions.has(task.sessionId)) return false;

  const onProcessTable = deps.sessionLiveOnProcessTable ?? ((id: string) => isSessionIdLiveOnProcessTable(id));
  return !(await onProcessTable(task.sessionId));
}

/**
 * Stops every task whose owner is gone or that sat untouched past `idleMs`. A recording task is
 * always kept: reaping it would truncate the capture, and recording proves it is in use.
 */
export async function reapAbandonedTasks(
  service: ReapableService,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const idleDisabled = opts.idleMs === null;
  const idleMs = idleDisabled ? undefined : (opts.idleMs ?? DEFAULT_IDLE_MS);
  // A `0` survives `??` and would close every task; a non-number silently disables idle reaping.
  // Both throw. `null` is the one deliberate way to turn idle reaping off.
  if (!idleDisabled && (!Number.isFinite(idleMs) || (idleMs as number) <= 0)) {
    throw new Error(`idleMs must be a positive number of milliseconds, got ${String(idleMs)}`);
  }
  const now = opts.now ?? Date.now();
  const deps = opts.deps ?? {};
  const live = resolveLiveIdentities(deps);

  const closed: ReapedTask[] = [];
  const failed: ReapResult['failed'] = [];
  let skipped = 0;

  for (const { profile, task } of service.listTasks()) {
    if ((await service.recordStatus(task.name)).recording) {
      skipped++;
      continue;
    }

    let reason: ReapedTask['reason'] | undefined;
    if (await taskOwnerIsGone(task, live, deps)) {
      reason = 'session-dead';
    } else if (!idleDisabled && now - (task.lastActionAt ?? task.createdAt) >= (idleMs as number)) {
      reason = 'idle';
    }

    if (!reason) {
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      // Report the BARE profile, exactly as the real run does below — `profile`
      // here is the runtime key from `listTasks()`, and printing the two shapes
      // in one column made `gc --dry-run` and `gc` disagree (RUSH-2709).
      closed.push({ task: task.name, profile: parseConnectionKey(profile).profile, reason });
      continue;
    }

    // One task whose close throws (an Arc tab moved to another Space, a dead
    // CDP socket) must not strand every task after it in the pass.
    let result: Awaited<ReturnType<ReapableService['stop']>>;
    try {
      result = await service.stop(task.name);
    } catch (err) {
      failed.push({
        task: task.name,
        profile: parseConnectionKey(profile).profile,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (result.ok) {
      closed.push({ task: task.name, profile: result.profile ?? profile, reason });
    } else {
      // `stop` reports not-found only when the task already left the map — a
      // concurrent `done`, or a profile torn down mid-pass. Nothing was closed,
      // so it is not reported as closed.
      skipped++;
    }
  }

  return { closed, skipped, failed };
}
