/**
 * The hardened `ssh` choke point: BatchMode, `accept-new` host keys, a connect timeout,
 * keepalive against zombie `-N` tunnels, and a target allowlist so no target reads as a flag.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserServiceDir, getBrowserSshDir } from './state.js';

/** A bare ssh-config alias (`winbox`) or `user@host`. Nothing else. */
export const SSH_TARGET_RE = /^[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/;

/**
 * Idle master lifetime: agents think for minutes between verbs, and a fresh handshake costs
 * ~270 ms against ~25 ms muxed. `ServerAlive*` still reaps it ~45 s after a dropped link.
 */
export const SSH_CONTROL_PERSIST_SECONDS = 30 * 60;

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function sshConnectOpts(mux: string[], hostKeyOpts?: string[]): string[] {
  return [...SSH_OPTS, ...mux, ...(hostKeyOpts ?? [])];
}

export function assertValidSshTarget(host: string): void {
  if (host.startsWith('-') || !SSH_TARGET_RE.test(host)) {
    throw new Error(
      `Invalid SSH target ${JSON.stringify(host)}. Expected a host alias or user@host (letters, digits, '.', '_', '-').`,
    );
  }
}

/**
 * Options applied to every connection. Keepalive (`ServerAlive*`) makes a detached
 * `ssh -L` tunnel exit within ~45s of a silently dropped link instead of hanging.
 */
export const SSH_OPTS: readonly string[] = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
];

/**
 * The longest socket path both platforms bind: macOS `sun_path` is 104 bytes, less
 * the NUL. ssh also binds a temporary `<ControlPath>.<16 random>` first.
 */
const SUN_PATH_MAX = 103;
const CONTROL_NAME = 'cm-%C';
const CONTROL_NAME_EXPANDED = 'cm-'.length + 40 + '.'.length + 16;

/** Long homes use independent SSH connections instead of writing sockets outside the browser home. */
export function controlDir(cacheDir: string = getBrowserServiceDir()): string | null {
  const preferred = getBrowserSshDir(cacheDir);
  if (preferred.length + 1 + CONTROL_NAME_EXPANDED > SUN_PATH_MAX) return null;
  try {
    fs.mkdirSync(preferred, { recursive: true, mode: 0o700 });
    return preferred;
  } catch {
    return null;
  }
}

const controlDirs = new Map<string, string | null>();

/**
 * Connection-multiplexing options, or none on Windows (no unix sockets) and
 * when no socket directory could be made, where ssh connects without a master.
 */
export function controlOpts(): string[] {
  if (process.platform === 'win32') return [];
  const cacheDir = getBrowserServiceDir();
  if (!controlDirs.has(cacheDir)) controlDirs.set(cacheDir, controlDir(cacheDir));
  const dir = controlDirs.get(cacheDir);
  if (!dir) return [];
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(dir, CONTROL_NAME)}`,
    '-o', `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}s`,
  ];
}

export interface SshExecOptions {
  input?: string;
  timeoutMs?: number;
  /** Extra flags inserted BEFORE the target — identity args from the parent. */
  extraSshArgs?: string[];
  multiplex?: boolean;
}

export interface SshExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run `remoteCmd` on `target` and capture stdout/stderr/exit. */
export function sshExec(target: string, remoteCmd: string, opts: SshExecOptions = {}): SshExecResult {
  assertValidSshTarget(target);
  const mux = opts.multiplex === false ? [] : controlOpts();
  const args = [...SSH_OPTS, ...mux, ...(opts.extraSshArgs ?? []), target, remoteCmd];
  const res = spawnSync('ssh', args, {
    input: opts.input,
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Node's spawnSync timeout kills via SIGTERM and sets res.signal — it does
  // NOT set error.code = 'ETIMEDOUT'. Check both so detection fires either way.
  const timedOut =
    !!(res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') ||
    (!!opts.timeoutMs && res.signal !== null);
  return {
    code: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
  };
}

/** Spawn options for a process that must outlive this CLI (the `-L` tunnel). */
export function backgroundSpawnOptions(
  opts: { cwd?: string; platform?: NodeJS.Platform } = {},
): { cwd: string; detached: boolean; windowsHide: boolean } {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? (process.env.HOME || process.cwd());
  if (platform === 'win32') return { cwd, detached: false, windowsHide: true };
  return { cwd, detached: true, windowsHide: false };
}
