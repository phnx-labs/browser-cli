import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserServiceDir, getBrowserServicePidPath, getBrowserServiceLogPath, getBrowserServiceLockPath, getLegacyBrowserPidPath, getLegacyBrowserSocketPath } from './state.js';
import { emit } from './events.js';
import * as net from 'node:net';
import { ipcEndpoint } from './platform.js';
export { getBrowserServiceDir, getBrowserServicePidPath, getBrowserServiceLogPath } from './state.js';
import { backgroundSpawnOptions } from './ssh.js';
import lockfile from 'proper-lockfile';

function readPid(file = getBrowserServicePidPath()): number | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pid file names the daemon only while that pid is still `browser __serve`:
 * after a crash or reboot it can be any process, and callers signal or wait on it.
 */
function isServePid(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8', timeout: 1000, windowsHide: true });
    return result.status === 0 && /(?:^|\s)__serve(?:\s|$)/.test(result.stdout);
  }
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes('__serve');
    } catch {
      return false;
    }
  }
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && /(^|\s)__serve(\s|$)/.test(ps.stdout.trim());
}

export function isDaemonRunning(): boolean {
  const pid = readPid();
  return pid !== null && isServePid(pid);
}

export function startDetached(argv: string[]): void {
  const log = getBrowserServiceLogPath();
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const out = fs.openSync(log, 'a');
  const child = spawn(argv[0], argv.slice(1), {
    ...backgroundSpawnOptions(),
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
}

export function startDaemon(): void {
  if (isDaemonRunning()) return;
  fs.mkdirSync(getBrowserServiceDir(), { recursive: true, mode: 0o700 });
  const self = process.execPath;
  const script = process.argv[1];
  const argv = script && !script.endsWith('browser') && !script.endsWith('browser.exe')
    ? [self, script, '__serve']
    : [self, '__serve'];
  startDetached(argv);
}

export function stopBrowserServiceProcess(): boolean {
  const pid = readPid();
  if (pid === null || !isServePid(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    spawnSync('sleep', ['0.05']);
  }
  try { fs.unlinkSync(getBrowserServicePidPath()); } catch { /* gone */ }
  return true;
}

export function writeServicePid(pid: number = process.pid): void {
  fs.mkdirSync(getBrowserServiceDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(getBrowserServicePidPath(), String(pid) + '\n');
}

/** Remove the pid file on a clean exit, unless a successor already wrote its own. */
export function clearServicePid(pid: number = process.pid): void {
  if (readPid() === pid) {
    try { fs.unlinkSync(getBrowserServicePidPath()); } catch { /* gone */ }
  }
}

/**
 * Hold the one-daemon-per-home lock for life, so two cold clients spawning `__serve` cannot
 * leave two daemons with their own tasks.json. False when another daemon holds it.
 */
export async function claimServiceLock(): Promise<boolean> {
  const dir = getBrowserServiceDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await lockfile.lock(dir, {
      lockfilePath: getBrowserServiceLockPath(),
      stale: 15_000,
      update: 5_000,
      realpath: false,
      onCompromised: (err) => {
        emit('daemon.lock_lost', { error: err.message });
        process.exit(1);
      },
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') return false;
    throw err;
  }
}

const legacyStops = new Map<string, Promise<boolean>>();

/** Probe at most once per process; an unverifiable or hung predecessor is left intact. */
export function stopLegacyBrowserService(log: (message: string) => void = console.error): Promise<boolean> {
  const endpoint = ipcEndpoint(getLegacyBrowserSocketPath());
  let pending = legacyStops.get(endpoint);
  if (!pending) {
    pending = stopLegacyEndpoint(endpoint).catch(error => {
      log(`browser migration: left old service at ${getLegacyBrowserSocketPath()} in place: ${error instanceof Error ? error.message : String(error)}. Stop that service, then restart the browser service to finish migration.`);
      return false;
    });
    legacyStops.set(endpoint, pending);
  }
  return pending;
}

async function stopLegacyEndpoint(endpoint: string): Promise<boolean> {
  const reachable = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setTimeout(300);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('old socket probe timed out')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (['ENOENT', 'ENOTDIR', 'ECONNREFUSED', 'EINVAL'].includes(error.code ?? '')) resolve(false);
      else reject(error);
    });
  });
  const pid = readPid(getLegacyBrowserPidPath());
  if (pid !== null && isServePid(pid)) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + 1500;
    while (isPidAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (isPidAlive(pid)) throw new Error(`old daemon ${pid} did not exit within 1.5 seconds`);
  } else if (reachable) {
    throw new Error('old socket is live but its daemon PID cannot be verified');
  }
  return true;
}
