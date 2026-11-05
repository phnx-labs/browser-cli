// Read-only listing of a profile's captures (`sessions/<task>/`, `downloads/`) straight from
// `.cache/browser/<profile>/`, so it works with the daemon down. Task rows merge durable summaries
// and live task metadata; nothing here needs the Sessions CLI or a conversation index.
import { showFile } from '../runtime/open-url.js';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_LIST_LIMIT, formatBytes, formatRelativeTime, listFooter, printJson, printLine, writeErr } from '@phnx-labs/tui';

import { getBrowserRuntimeDir, getProfileRuntimeDir } from './profiles.js';
import { listProfileCacheDirs } from './runtime-state.js';
import { listBrowserSessionRecords, pruneToolSessions } from '../runtime/session-store.js';
import type { TaskSummary } from '../runtime/task-history.js';
import { keyBelongsToProfile } from './types.js';
import { inTimeWindow, type TimeWindow } from '../runtime/time-filter.js';

export type ArtifactKind = 'screenshot' | 'pdf' | 'recording' | 'download';

export interface BrowserArtifact {
  kind: ArtifactKind;
  /** Owning task for session captures; undefined for downloads. */
  task?: string;
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ProfileArtifacts {
  profile: string;
  artifacts: BrowserArtifact[];
}

const EXT_KIND: Record<string, ArtifactKind> = {
  '.png': 'screenshot',
  '.jpg': 'screenshot',
  '.jpeg': 'screenshot',
  '.webp': 'screenshot',
  '.pdf': 'pdf',
  '.webm': 'recording',
};

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function walkFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Captures stay at their recorded location, including a migrated task directory. */
export function listTaskArtifacts(directory: string, task: string): BrowserArtifact[] {
  const artifacts: BrowserArtifact[] = [];
  for (const file of walkFiles(directory)) {
    const kind = EXT_KIND[path.extname(file).toLowerCase()];
    if (!kind) continue;
    const st = statSafe(file);
    if (st) artifacts.push({ kind, task, name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Every capture for one profile, newest first. */
export function listProfileArtifacts(profile: string): BrowserArtifact[] {
  const root = getProfileRuntimeDir(profile);
  const artifacts: BrowserArtifact[] = [];

  const sessionsRoot = path.join(root, 'sessions');
  let taskDirs: fs.Dirent[] = [];
  try { taskDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { /* none */ }
  for (const t of taskDirs) {
    if (!t.isDirectory()) continue;
    artifacts.push(...listTaskArtifacts(path.join(sessionsRoot, t.name), t.name));
  }

  for (const file of walkFiles(path.join(root, 'downloads'))) {
    const st = statSafe(file);
    if (!st) continue;
    artifacts.push({ kind: 'download', name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }

  artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return artifacts;
}

/**
 * Captures grouped by profile. With `only` set, returns just that profile (even
 * when empty); otherwise every profile dir on disk that has at least one capture.
 */
export function listBrowserSessions(only?: string): ProfileArtifacts[] {
  let profiles: string[];
  if (only) {
    // Tasks live under composite dirs (`<name>@<device>`, forks), not the bare `<name>`, so resolve
    // every dir the profile owns. A profile with none on disk yet still returns its empty entry.
    const dirs = listProfileCacheDirs(only).map((d) => path.basename(d));
    profiles = dirs.length > 0 ? dirs : [only];
  } else {
    try {
      profiles = fs.readdirSync(getBrowserRuntimeDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'sessions')
        .map((e) => e.name)
        .sort();
    } catch {
      profiles = [];
    }
  }
  return profiles
    .map((p) => ({ profile: p, artifacts: listProfileArtifacts(p) }))
    .filter((r) => !!only || r.artifacts.length > 0);
}

/** Per-kind counts over a flat artifact list — shared by the printed table and
 *  the interactive row labels. */
export function countByKind(artifacts: BrowserArtifact[]): Record<ArtifactKind, number> {
  const counts = { screenshot: 0, pdf: 0, recording: 0, download: 0 } as Record<ArtifactKind, number>;
  for (const a of artifacts) counts[a.kind]++;
  return counts;
}

/** Keep the newest `limit` captures across every profile. A profile that had
 *  captures but lost all of them to the cap is dropped; an empty one stays. */
export function limitArtifactGroups(groups: ProfileArtifacts[], limit: number): { groups: ProfileArtifacts[]; more: number } {
  const all = groups.flatMap((g) => g.artifacts).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(all.slice(0, limit));
  return {
    groups: groups
      .map((g) => ({ ...g, artifacts: g.artifacts.filter((a) => keep.has(a)) }))
      .filter((g, i) => g.artifacts.length > 0 || groups[i].artifacts.length === 0),
    more: all.length - keep.size,
  };
}

/** Drop captures whose mtime falls outside `window`. With `keepEmpty` (an
 *  explicit `--profile`), a profile with nothing left still reports itself. */
export function filterArtifactGroups(groups: ProfileArtifacts[], window: TimeWindow, keepEmpty: boolean): ProfileArtifacts[] {
  return groups
    .map((g) => ({ ...g, artifacts: g.artifacts.filter((a) => inTimeWindow(a.mtimeMs, window)) }))
    .filter((g) => keepEmpty || g.artifacts.length > 0);
}

/**
 * The CLI table, without a trailing newline. `limit` caps the capture lines printed, not the
 * per-profile counts; the count footer is `runBrowserSessions`'s, on stderr.
 */
export function renderBrowserSessions(groups: ProfileArtifacts[], limit = Infinity): string {
  if (groups.length === 0) return 'No browser profiles found.';
  const fullCounts = new Map(groups.map((g) => [g.profile, countByKind(g.artifacts)]));
  const { groups: shown } = limitArtifactGroups(groups, limit);
  const lines: string[] = [];
  for (const g of shown) {
    const counts = fullCounts.get(g.profile)!;
    lines.push(
      `${g.profile}  ` +
      `screenshots ${counts.screenshot}  pdfs ${counts.pdf}  recordings ${counts.recording}  downloads ${counts.download}`
    );
    if (g.artifacts.length === 0) {
      lines.push('  (no captures yet)');
      continue;
    }
    for (const a of g.artifacts) {
      const when = formatRelativeTime(new Date(a.mtimeMs).toISOString());
      const where = a.kind === 'download' ? 'downloads/' : `sessions/${a.task}/`;
      lines.push(`  ${when.padEnd(12)}  ${a.name.padEnd(28)}  ${formatBytes(a.bytes).padStart(8)}  ${where}`);
    }
  }
  return lines.join('\n');
}

/**
 * Resolve `--open <sel>`: `latest` (newest across the groups) or a filename
 * substring match. Returns the absolute path, or null if nothing matched.
 */
export function resolveArtifact(groups: ProfileArtifacts[], selector: string): string | null {
  const all = groups.flatMap((g) => g.artifacts).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (all.length === 0) return null;
  if (selector === 'latest') return all[0].path;
  const hit = all.find((a) => a.name === selector) ?? all.find((a) => a.name.includes(selector));
  return hit ? hit.path : null;
}



// ─── Task-first grouping (RUSH-2407) ───────────────────────────────────────

/** The identity fields this module cares about for one task. */
export interface TaskIdentity {
  owner?: string;
  launchId?: string;
  /**
   * The agent session that drove the task: the primary identity, since few processes carry a
   * launch id. From the durable `browser_sessions` row, which survives task stop.
   */
  sessionId?: string;
  lastActivity?: number;
  startedAt?: number;
  machine?: string;
  captureDir?: string;
  capturesRemote?: string;
  counts?: TaskSummary['counts'];
}

/**
 * Identities of a profile's live tasks from `tasks.json`, by task name. `browser stop` deletes the
 * entry, so an ended task is absent while its captures remain: {@link groupIntoRows}'s unlinked case.
 */
export function loadTaskIdentities(profile: string): Map<string, TaskIdentity> {
  const out = new Map<string, TaskIdentity>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getProfileRuntimeDir(profile), 'tasks.json'), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const t = value as Record<string, unknown>;
    out.set(name, {
      owner: typeof t.owner === 'string' ? t.owner : undefined,
      launchId: typeof t.launchId === 'string' ? t.launchId : undefined,
      sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
      lastActivity: typeof t.lastActionAt === 'number' ? t.lastActionAt : typeof t.createdAt === 'number' ? t.createdAt : undefined,
    });
  }
  return out;
}

/**
 * Task identities from the never-deleted `browser_sessions` rows, so stopped tasks answer too, with
 * live `tasks.json` merged on top for a running task an older CLI started without a row.
 */
export function loadDurableTaskIdentities(profile: string): Map<string, TaskIdentity> {
  const merged = new Map<string, TaskIdentity>();
  for (const record of listBrowserSessionRecords(profile)) {
    merged.set(record.task, {
      ...record,
      owner: record.actor,
      launchId: record.launchId,
      sessionId: record.sessionId,
      lastActivity: record.lastActivity,
    });
  }
  for (const [task, live] of loadTaskIdentities(profile)) {
    const durable = merged.get(task);
    merged.set(task, {
      ...durable,
      owner: live.owner ?? durable?.owner,
      launchId: live.launchId ?? durable?.launchId,
      sessionId: live.sessionId ?? durable?.sessionId,
      lastActivity: live.lastActivity ?? durable?.lastActivity,
    });
  }
  return merged;
}

/** `unresolved` records a session or launch id that this tool does not look up;
 *  `unlinked` has neither (a legacy task, or one whose owning run already stopped). */
export type BrowserSessionLinkStatus = 'unresolved' | 'unlinked';

/** One task-first row: every capture for one browser task (or, for
 *  `kind: 'downloads'`, one profile's downloads bucket). */
export interface BrowserSessionRow {
  kind: 'task' | 'downloads';
  profile: string;
  /** Task name; undefined for the downloads row. */
  task?: string;
  owner?: string;
  launchId?: string;
  /** The agent session that drove the task, when one was recorded. */
  sessionId?: string;
  linkStatus: BrowserSessionLinkStatus;
  /** Newest first. */
  artifacts: BrowserArtifact[];
  counts: Record<ArtifactKind, number>;
  /** Most recent capture's mtime — the row's sort/age key. */
  latestMtimeMs: number;
  startedAt?: number;
  machine?: string;
  captureDir?: string;
  capturesRemote?: string;
}

/**
 * Groups per-profile artifacts into task-first rows, newest first. Pure: identities are passed in;
 * {@link buildBrowserSessionRows} is the disk-reading caller.
 */
export function groupIntoRows(
  groups: ProfileArtifacts[],
  taskIdentities: Map<string, Map<string, TaskIdentity>>,
): BrowserSessionRow[] {
  const rows: BrowserSessionRow[] = [];
  for (const g of groups) {
    const identities = taskIdentities.get(g.profile) ?? new Map<string, TaskIdentity>();
    const byTask = new Map<string, BrowserArtifact[]>();
    const downloads: BrowserArtifact[] = [];
    for (const a of g.artifacts) {
      if (a.kind === 'download' || !a.task) {
        downloads.push(a);
        continue;
      }
      const list = byTask.get(a.task) ?? [];
      list.push(a);
      byTask.set(a.task, list);
    }
    for (const task of identities.keys()) {
      if (!byTask.has(task)) byTask.set(task, []);
    }
    for (const [task, artifacts] of byTask) {
      artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const identity = identities.get(task);
      const hasIdentityKey = !!(identity?.sessionId || identity?.launchId);
      rows.push({
        kind: 'task',
        profile: g.profile,
        task,
        owner: identity?.owner,
        launchId: identity?.launchId,
        sessionId: identity?.sessionId,
        linkStatus: hasIdentityKey ? 'unresolved' : 'unlinked',
        artifacts,
        counts: Object.fromEntries(Object.entries(countByKind(artifacts)).map(([kind, n]) =>
          [kind, Math.max(n, identity?.counts?.[kind as ArtifactKind] ?? 0)])) as Record<ArtifactKind, number>,
        startedAt: identity?.startedAt, machine: identity?.machine,
        captureDir: identity?.captureDir, capturesRemote: identity?.capturesRemote,
        latestMtimeMs: Math.max(artifacts[0]?.mtimeMs ?? 0, identity?.lastActivity ?? 0),
      });
    }
    if (downloads.length > 0) {
      downloads.sort((a, b) => b.mtimeMs - a.mtimeMs);
      rows.push({
        kind: 'downloads',
        profile: g.profile,
        linkStatus: 'unlinked',
        artifacts: downloads,
        counts: countByKind(downloads),
        latestMtimeMs: downloads[0]?.mtimeMs ?? 0,
      });
    }
  }
  rows.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
  return rows;
}

/** Build task-first rows for one profile (or every profile with captures),
 *  reading native summaries and `tasks.json`, without a conversation index.
 *  The interactive picker's data source. */
export function buildBrowserSessionRows(profile?: string): BrowserSessionRow[] {
  // Retention runs from BOTH listing paths, not just the computer one: a box
  // that uses `browser` and never runs `agents sessions --computer`
  // would otherwise never sweep either table. Best-effort — a read-only DB
  // must not break a listing.
  try { pruneToolSessions(); } catch { /* listing must not fail on retention */ }
  const groups = listBrowserSessions(profile);
  const profiles = new Set(groups.map(group => group.profile));
  for (const record of listBrowserSessionRecords()) {
    if ((!profile || keyBelongsToProfile(record.profile, profile)) && !profiles.has(record.profile)) {
      profiles.add(record.profile);
      groups.push({ profile: record.profile, artifacts: listProfileArtifacts(record.profile) });
    }
    if ((!profile || keyBelongsToProfile(record.profile, profile)) && record.captureDir && !record.capturesRemote) {
      const group = groups.find(g => g.profile === record.profile)!;
      const paths = new Set(group.artifacts.map(a => a.path));
      group.artifacts.push(...listTaskArtifacts(record.captureDir, record.task).filter(a => !paths.has(a.path)));
    }
  }
  // Live tasks without captures still belong in the history browser.
  const runtimeNames = profile ? listProfileCacheDirs(profile).map(dir => path.basename(dir))
    : fs.existsSync(getBrowserRuntimeDir()) ? fs.readdirSync(getBrowserRuntimeDir(), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  for (const name of runtimeNames) {
    if (!profiles.has(name) && loadTaskIdentities(name).size) {
      profiles.add(name);
      groups.push({ profile: name, artifacts: [] });
    }
  }
  const taskIdentities = new Map(groups.map((g) => [g.profile, loadDurableTaskIdentities(g.profile)]));
  return groupIntoRows(groups, taskIdentities);
}

/**
 * Search predicate for the interactive picker: task name, profile, owner,
 * session and launch references, and any artifact filename in the row.
 */
export function matchesBrowserSessionRow(row: BrowserSessionRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.task?.toLowerCase().includes(q)) return true;
  if (row.profile.toLowerCase().includes(q)) return true;
  if ([row.owner, row.sessionId, row.launchId].some(value => value?.toLowerCase().includes(q))) return true;
  if (row.kind === 'downloads' && 'downloads'.includes(q)) return true;
  return row.artifacts.some((a) => a.name.toLowerCase().includes(q));
}

/**
 * The `browser sessions` action. `open` is `--open [selector]` (bare `true` means 'latest');
 * an explicit `limit` also caps `--json`.
 */
export async function runBrowserSessions(opts: { profile?: string; open?: string | boolean; json?: boolean; limit?: number }, filtered?: ProfileArtifacts[]): Promise<void> {
  const groups = filtered ?? listBrowserSessions(opts.profile);

  if (opts.open !== undefined && opts.open !== false) {
    const selector = opts.open === true ? 'latest' : opts.open;
    const target = resolveArtifact(groups, selector);
    if (!target) {
      writeErr(`No capture matching "${selector}".\n`);
      process.exit(1);
    }
    printLine(target);
    if ((await showFile(target)).via === 'none') {
      writeErr(`Could not open ${target}\n`);
      process.exit(1);
    }
    return;
  }

  if (opts.json) {
    printJson(opts.limit === undefined ? groups : limitArtifactGroups(groups, opts.limit).groups);
    return;
  }

  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  printLine(renderBrowserSessions(groups, limit));
  const total = groups.reduce((n, g) => n + g.artifacts.length, 0);
  if (total > 0) {
    writeErr(`${listFooter({ shown: Math.min(total, limit), total, noun: 'capture', narrowHint: '--profile or --since to narrow' })}\n`);
  }
}
