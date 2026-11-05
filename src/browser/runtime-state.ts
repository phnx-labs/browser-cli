import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  getProfileRuntimeDir,
  getBrowserRuntimeDir,
  getEndpointPresets,
  listProfiles,
  getConfiguredDefaultProfileName,
  isProfileLaunchableHere,
  isProfileDeclaredHere,
  deleteProfile,
  nativeIdentity,
  DEFAULT_BROWSER_PROFILE_NAME,
  LEGACY_DEFAULT_BROWSER_PROFILE_NAME,
  type BrowserProfileWithDeclarations,
} from './profiles.js';
import { keyBelongsToProfile, type ProfileName } from './types.js';
import { declaringDevices, profileKind } from './registry.js';
import { machineId } from '../runtime/machine-id.js';

/**
 * `identity`: exactly one device declares the name; `fungible`: several do, each with its own
 * browser. Prune sees only profiles declared here, so `fungible` means "and elsewhere too".
 */
type PruneProfileClass = 'identity' | 'fungible';

/**
 * Flags an identity profile whose loopback endpoint is read off its declaring device, where it
 * means this machine's browser. The CLI forwards it there and the daemon refuses it; doctor flags it.
 */
export function identityLoopbackMismatch(
  profile: BrowserProfileWithDeclarations,
): { misfiled: false } | { misfiled: true; why: string } {
  if (profileKind(profile.name) !== 'identity') return { misfiled: false };
  const declaringDevice = declaringDevices(profile.name)[0];
  if (!declaringDevice || declaringDevice === machineId()) return { misfiled: false };

  const presets = getEndpointPresets(profile);
  const chosen =
    profile.defaultEndpoint && presets[profile.defaultEndpoint]
      ? profile.defaultEndpoint
      : Object.keys(presets)[0];
  if (!chosen) return { misfiled: false };

  const target = presets[chosen].target;
  if (!target.startsWith('cdp://')) return { misfiled: false };
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return { misfiled: false };
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    return { misfiled: false };
  }

  const here = machineId();
  return {
    misfiled: true,
    why:
      `identity-bearing profile declared on ${declaringDevice}, but "${target}" is a loopback endpoint — ` +
      `on ${here} that address is this device's own browser, not ${declaringDevice}'s. ` +
      `Diagnose the real browser on ${declaringDevice}: browser profiles doctor ${profile.name}`,
  };
}

/**
 * Runtime record under `~/.agents/.cache/browser/<composite>/`. `command` guards against pid reuse;
 * `meta.json` is the full record the reaper reads, and the one-value files remain for older builds.
 */
export interface ProfileRuntime {
  pid: number;
  port?: number;
  command?: string;
  /** Full path of the user-data-dir we passed to --user-data-dir, used by the reaper to confirm. */
  userDataDir?: string;
  /** PID of the daemon that spawned this. When the daemon dies, the next one reaps. */
  daemonPid?: number;
  /** Wall-clock time of spawn — useful for diagnostics and TTL-based cleanup. */
  spawnedAt?: number;
  /** What kind of process: 'browser' (Chrome-family), 'electron' (Notion etc.), or 'tunnel' (ssh -L). */
  kind?: 'browser' | 'electron' | 'tunnel';
  /** Local ssh -L PID, if this profile is SSH-backed. Distinct from `pid` (which is the remote browser, normally 0). */
  tunnelPid?: number;
}

const PID_FILE = 'pid';
const PORT_FILE = 'port';
const COMMAND_FILE = 'command';
const META_FILE = 'meta.json';

function readNumberFile(p: string): number | null {
  try {
    const n = parseInt(fs.readFileSync(p, 'utf-8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStringFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Writes the legacy one-value files plus `meta.json`, creating the cache dir on first launch. */
export function writeProfileRuntime(
  profileName: string,
  runtime: ProfileRuntime
): void {
  const dir = getProfileRuntimeDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PID_FILE), String(runtime.pid));
  if (runtime.port !== undefined) {
    fs.writeFileSync(path.join(dir, PORT_FILE), String(runtime.port));
  } else {
    try { fs.unlinkSync(path.join(dir, PORT_FILE)); } catch { /* not present */ }
  }
  if (runtime.command) {
    fs.writeFileSync(path.join(dir, COMMAND_FILE), runtime.command);
  }
  const meta: ProfileRuntime = {
    ...runtime,
    daemonPid: runtime.daemonPid ?? process.pid,
    spawnedAt: runtime.spawnedAt ?? Date.now(),
  };
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta));
}

/** Read just the JSON meta record. Returns null when absent or malformed. */
export function readProfileRuntimeMeta(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf-8');
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as ProfileRuntime;
  } catch {
    return null;
  }
}

/**
 * The pid/port/command triple, or null when missing or the pid no longer runs the recorded
 * command; a stale record is cleared so the next caller does not act on it.
 */
export function readProfileRuntime(profileName: string): ProfileRuntime | null {
  const dir = getProfileRuntimeDir(profileName);
  const pid = readNumberFile(path.join(dir, PID_FILE));
  const port = readNumberFile(path.join(dir, PORT_FILE));
  const command = readStringFile(path.join(dir, COMMAND_FILE)) ?? undefined;

  if (pid === null || port === null) return null;

  if (!isProcessAlive(pid, command)) {
    clearProfileRuntime(profileName);
    return null;
  }

  return { pid, port, command };
}

/** Remove the pid/port/command/meta files. Leaves chrome-data + tasks.json intact. */
export function clearProfileRuntime(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  for (const f of [PID_FILE, PORT_FILE, COMMAND_FILE, META_FILE]) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* not present */ }
  }
}

/** Removes the whole profile cache so a recreated profile name does not inherit its history. */
export function removeProfileCache(profileName: string): void {
  const dir = getProfileRuntimeDir(profileName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

/**
 * Every cache dir of a profile. A dir name is a connection key (`<name>@<endpoint>[.<fork>]`),
 * matched by {@link keyBelongsToProfile}, the same rule `status`, `stopProfile` and `findTask` use.
 */
export function listProfileCacheDirs(profileName: ProfileName): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (keyBelongsToProfile(entry, profileName)) matches.push(path.join(root, entry));
  }
  return matches;
}

/**
 * Pid-reuse-safe liveness: with a recorded executable basename the live pid must still run it,
 * else existence suffices. `pid: 0` (attached to an external browser) always counts as alive.
 */
export function isProcessAlive(pid: number, expectedCommand?: string): boolean {
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err && err.code === 'EPERM') {
      // exists but we can't signal it — count it as alive
      return !expectedCommand || matchesCommand(pid, expectedCommand);
    }
    return false;
  }
  if (!expectedCommand) return true;
  return matchesCommand(pid, expectedCommand);
}

/** One tracked profile for `browser ps`: the meta record plus live probes of its processes. */
export interface ProfileSnapshot {
  /** Composite name as the cache dir is keyed: `<profile>` or `<profile>@<endpoint>`. */
  name: string;
  /** Absolute path of the cache dir. */
  dir: string;
  meta: ProfileRuntime | null;
  /** Live-process probe: does the recorded pid still exist + match command? */
  pidAlive: boolean;
  /** Live-process probe for the tunnel pid (SSH profiles). */
  tunnelAlive: boolean;
  /** True iff the daemon that started this is still alive. False == orphaned. */
  daemonAlive: boolean;
  /** Number of tasks recorded in tasks.json (open browser tabs). */
  taskCount: number;
}

/** Snapshots every profile cache dir from disk, so `browser ps` works with the daemon down. */
export function listAllProfileSnapshots(): ProfileSnapshot[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const out: ProfileSnapshot[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const meta = readProfileRuntimeMeta(name);
    const taskCount = readTaskCount(dir);

    const pidAlive = meta ? isProcessAlive(meta.pid, meta.command) : false;
    const tunnelAlive = meta?.tunnelPid ? isProcessAlive(meta.tunnelPid, 'ssh') : false;
    const daemonAlive = meta?.daemonPid ? isProcessAlive(meta.daemonPid) : false;

    out.push({ name, dir, meta, pidAlive, tunnelAlive, daemonAlive, taskCount });
  }
  return out;
}

function readTaskCount(dir: string): number {
  try {
    const raw = fs.readFileSync(path.join(dir, 'tasks.json'), 'utf-8');
    const obj = JSON.parse(raw);
    if (Array.isArray(obj)) return obj.length;
    if (obj && typeof obj === 'object') return Object.keys(obj).length;
    return 0;
  } catch {
    return 0;
  }
}

/** Reaps dead daemons' `ssh -L` tunnels and clears their dead browser records. A live browser
 * outliving its daemon is normal and kept (`adoptProfileRuntimeOwner`, `hygiene.ts`); clearing
 * its record would lose the port, and a second browser would launch beside it. */
export function reapOrphanedProcesses(): { reaped: number; details: string[] } {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return { reaped: 0, details: [] };

  let reaped = 0;
  const details: string[] = [];

  for (const profileName of fs.readdirSync(root)) {
    const meta = readProfileRuntimeMeta(profileName);
    if (!meta) continue;
    if (!meta.daemonPid) continue;
    if (meta.daemonPid === process.pid) continue;
    // Owning daemon still alive — leave its kids alone.
    if (isProcessAlive(meta.daemonPid)) continue;

    // A local `ssh -L` whose owner is gone is genuinely orphaned: nothing is
    // driving it and it cannot be re-adopted, so it is the one process to signal.
    // Matched against the recorded command (or `ssh`) so a recycled pid is not
    // mistaken for our tunnel.
    if (meta.tunnelPid && meta.tunnelPid !== 0) {
      const cmdOk = !meta.command
        || matchesCommand(meta.tunnelPid, meta.command)
        || matchesCommand(meta.tunnelPid, 'ssh');
      if (cmdOk) {
        try {
          process.kill(meta.tunnelPid, 'SIGTERM');
          reaped++;
          details.push(`reaped tunnel ${meta.tunnelPid} (profile ${profileName})`);
        } catch { /* already gone */ }
      }
    }

    // A tunnel-kind record has no local browser of its own, so clearing it is the
    // whole cleanup. `pid` on such a record is the REMOTE browser (normally 0) and
    // is never ours to signal.
    if (meta.kind === 'tunnel') {
      clearProfileRuntime(profileName);
      continue;
    }

    // `isProcessAlive` re-checks the recorded command, so a recycled pid does not
    // read as our browser. A record with no pid at all is stale by definition.
    const liveBrowser = !!meta.pid && meta.pid !== 0 && isProcessAlive(meta.pid, meta.command);
    if (liveBrowser) {
      details.push(`preserved live browser ${meta.pid} (profile ${profileName})`);
      continue;
    }

    // Dead browser: clear the stale record. No signal — there is nothing there.
    clearProfileRuntime(profileName);
    if (meta.pid) details.push(`cleared dead browser record ${meta.pid} (profile ${profileName})`);
  }

  return { reaped, details };
}

/**
 * Hands a record to this daemon after an identity-checked attach. Rewrites `daemonPid` alone so the
 * launch provenance survives, and never recreates a record that has since disappeared.
 */
export function adoptProfileRuntimeOwner(profileName: string, daemonPid = process.pid): boolean {
  const meta = readProfileRuntimeMeta(profileName);
  if (!meta) return false;
  if (meta.daemonPid === daemonPid) return true;
  const dir = getProfileRuntimeDir(profileName);
  try {
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({ ...meta, daemonPid }));
    return true;
  } catch {
    // Losing the handover is not worth failing an otherwise good attach; the next
    // startup simply preserves the browser again and re-attaches.
    return false;
  }
}

/**
 * True when any of the profile's cache dirs has a live browser or tunnel, or an open task.
 * `pid: 0` is someone else's browser, so only its open tasks count.
 */
export function isProfileInUse(profileName: string): boolean {
  for (const dir of listProfileCacheDirs(profileName)) {
    const entry = path.basename(dir);
    if (readTaskCount(dir) > 0) return true;
    const meta = readProfileRuntimeMeta(entry);
    if (!meta) continue;
    if (meta.pid && isProcessAlive(meta.pid, meta.command)) return true;
    if (meta.tunnelPid && isProcessAlive(meta.tunnelPid, 'ssh')) return true;
  }
  return false;
}

/** Why a profile is considered dead. */
export type PruneReason = 'binary-missing' | 'never-used' | 'duplicate';

export interface PruneCandidate {
  name: string;
  scope: PruneProfileClass;
  reason: PruneReason;
  /** For `duplicate`: the saved row that stands for the same login and is kept. */
  duplicateOf?: string;
  /** Cache dirs that would be removed along with the config entry. */
  cacheDirs: string[];
}

export interface PrunePlan {
  /** Profiles that would be (or were) removed. */
  candidates: PruneCandidate[];
  /** Profiles deliberately left alone, with the guard that kept them. */
  kept: Array<{
    name: string;
    scope: PruneProfileClass;
    why: string;
    /**
     * Identity profile whose loopback endpoint only works on its declaring device. A flag so the
     * CLI and `--json` consumers need not parse `why`.
     */
    misfiled?: boolean;
  }>;
}

export const PRUNE_REASON_TEXT: Record<PruneReason, string> = {
  'binary-missing': 'its browser/binary is not installed on this machine',
  'never-used': 'it has never been started (no runtime dir)',
  duplicate: 'duplicate: same login as',
};

/**
 * Decides which profiles are dead without touching anything, so `--dry-run` matches the real run.
 * Gap: configs record no creation time, so a just-created, unstarted profile reads `never-used`.
 */
export function planProfilePrune(
  profiles: Array<{
    name: string;
    scope: PruneProfileClass;
    launchableHere: boolean;
    /** Set when this identity-bearing profile's endpoint only makes sense on one machine. */
    misfiledWhy?: string;
    /** Set when the row stands for a native browser profile (Arc, Comet, Firefox). */
    nativeBacked?: boolean;
    /** Set when another saved row stands for the same login and is the one kept. */
    duplicateOf?: string;
  }>,
  opts: { configuredDefault?: string } = {}
): PrunePlan {
  const plan: PrunePlan = { candidates: [], kept: [] };

  for (const { name, scope, launchableHere, misfiledWhy, nativeBacked, duplicateOf } of profiles) {
    const keep = (why: string, misfiled = false): void => {
      plan.kept.push(misfiled ? { name, scope, why, misfiled } : { name, scope, why });
    };

    // Checked first: a misfiled profile's browser is absent wherever you stand, so pruning would
    // delete the declaring device's entry. The repair is declaring it only where the browser lives.
    if (misfiledWhy) {
      keep(`MISFILED — ${misfiledWhy}`, true);
      continue;
    }

    // Not re-created on demand: pruning it sends the user back through `agents setup`.
    if (name === DEFAULT_BROWSER_PROFILE_NAME || name === LEGACY_DEFAULT_BROWSER_PROFILE_NAME) {
      keep('the auto-detected default profile');
      continue;
    }
    if (opts.configuredDefault && name === opts.configuredDefault) {
      keep("this machine's configured default profile");
      continue;
    }
    if (isProfileInUse(name)) {
      keep('in use (live browser, tunnel, or open task)');
      continue;
    }

    const cacheDirs = listProfileCacheDirs(name);
    if (duplicateOf) {
      plan.candidates.push({ name, scope, reason: 'duplicate', duplicateOf, cacheDirs });
      continue;
    }
    if (!launchableHere) {
      plan.candidates.push({ name, scope, reason: 'binary-missing', cacheDirs });
      continue;
    }
    // The owner chose this name; pruning it would bring the profile back under its discovered one.
    if (nativeBacked) {
      keep('the saved name for a native browser profile');
      continue;
    }
    if (cacheDirs.length === 0) {
      plan.candidates.push({ name, scope, reason: 'never-used', cacheDirs });
      continue;
    }
    keep('healthy (browser installed, has runtime state)');
  }

  return plan;
}

/**
 * Build the prune plan from live config. Split from {@link planProfilePrune} so
 * the decision rules stay unit-testable without a configured machine.
 */
export async function buildProfilePrunePlan(): Promise<PrunePlan> {
  const current = machineId();
  const profiles = await listProfiles();
  const declaredHere: Parameters<typeof planProfilePrune>[0] = [];
  const peerKept: PrunePlan['kept'] = [];
  const identities = new Map<string, string | undefined>();

  for (const profile of profiles) {
    const scope: PruneProfileClass = profile.devices.length > 1 ? 'fungible' : 'identity';
    const misfiled = identityLoopbackMismatch(profile);
    if (profile.arc && !isProfileDeclaredHere(profile.name)) {
      peerKept.push({
        name: profile.name,
        scope,
        why: 'read-only native Arc discovery; no agents-cli alias to prune',
      });
      continue;
    }
    if (profile.devices.includes(current)) {
      declaredHere.push({
        name: profile.name,
        scope,
        launchableHere: isProfileLaunchableHere(profile),
        misfiledWhy: misfiled.misfiled ? misfiled.why : undefined,
        nativeBacked: nativeIdentity(profile) !== undefined,
      });
      identities.set(profile.name, nativeIdentity(profile));
      continue;
    }
    if (misfiled.misfiled) {
      peerKept.push({
        name: profile.name,
        scope,
        why: `MISFILED — ${misfiled.why}`,
        misfiled: true,
      });
    } else {
      peerKept.push({
        name: profile.name,
        scope,
        why: `declared on ${profile.devices.join(', ')}, not this device`,
      });
    }
  }

  const configuredDefault = getConfiguredDefaultProfileName();
  markDuplicates(declaredHere, identities, configuredDefault);
  const plan = planProfilePrune(declaredHere, { configuredDefault });
  plan.kept.push(...peerKept);
  return plan;
}

/**
 * Marks rows for the same login with `duplicateOf`, keeping the configured default, else one with
 * runtime state, else the first saved.
 */
export function markDuplicates(
  rows: Parameters<typeof planProfilePrune>[0],
  identities: Map<string, string | undefined>,
  configuredDefault?: string,
): void {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const identity = identities.get(row.name);
    if (!identity) continue;
    groups.set(identity, [...(groups.get(identity) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kept =
      group.find((row) => row.name === configuredDefault) ??
      group.find((row) => listProfileCacheDirs(row.name).length > 0) ??
      group[0];
    for (const row of group) if (row !== kept) row.duplicateOf = kept.name;
  }
}

/** Applies a prune plan (config entries and cache dirs) and returns it, matching `--dry-run`. */
export async function pruneProfiles(plan: PrunePlan): Promise<PrunePlan> {
  for (const candidate of plan.candidates) {
    await deleteProfile(candidate.name);
    for (const dir of candidate.cacheDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    removeProfileCache(candidate.name);
  }
  return plan;
}

function matchesCommand(pid: number, expectedCommand: string): boolean {
  const out = liveProcessCommand(pid);
  if (!out) return false;
  // Match on the basename only — `/Applications/Comet.app/Contents/MacOS/Comet`
  // vs the recorded `Comet`, vs `Google\ Chrome`, vs Windows `chrome.exe`.
  // Case-insensitive.
  const live = path.basename(out).toLowerCase();
  const want = path.basename(expectedCommand).toLowerCase();
  return live === want || live.startsWith(want) || want.startsWith(live);
}

/**
 * The image name the live `pid` runs, or null: `tasklist` CSV on Windows (no `ps`), else `ps -o comm=`.
 */
export function liveProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      // Rows look like: "node.exe","1234","Console","1","12,345 K"
      // A no-match prints an "INFO: No tasks..." line that won't match the regex.
      const m = out.match(/^"([^"]+)"/);
      return m ? m[1] : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
