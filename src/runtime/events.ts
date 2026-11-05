import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadContext } from './context.js';
import { appendAction } from './session-store.js';
import { getBrowserDaemonLogPath } from './state.js';

export const EVENT_FD_ENV = 'BROWSER_EVENTS_FD';

export interface BrowserActionRecord {
  event: 'browser.action';
  ts: string;
  command: string;
  invocationId: string;
  pid: number;
  task?: string;
  profile?: string;
  url?: string;
  host?: string;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  [key: string]: unknown;
}

const INVOCATION_ID = randomUUID();

export function invocationId(): string {
  return INVOCATION_ID;
}

function sessionIdentity(env: NodeJS.ProcessEnv): { sessionId?: string; launchId?: string; actor?: string } {
  let ctx = null;
  try {
    ctx = loadContext(env);
  } catch { /* bookkeeping must not fail the verb */ }
  return {
    sessionId: ctx?.session?.sessionId
      ?? env.AGENT_SESSION_ID ?? env.AGENTS_SESSION_ID
      ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID,
    launchId: ctx?.session?.launchId ?? env.AGENT_LAUNCH_ID,
    actor: ctx?.session?.actor ?? env.AGENTS_ACTOR,
  };
}

function writeToEventFd(line: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[EVENT_FD_ENV];
  if (!raw) return false;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 0) return false;
  try {
    fs.writeSync(fd, line);
    return true;
  } catch {
    return false;
  }
}

export function logUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.origin === 'null' && u.protocol !== 'file:') return u.protocol;
    u.username = u.password = u.search = u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

function withLogUrl(fields: Record<string, unknown>): Record<string, unknown> {
  return typeof fields.url === 'string' ? { ...fields, url: logUrl(fields.url) } : fields;
}

export function emitBrowserAction(
  verb: string,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const record: BrowserActionRecord = {
    event: 'browser.action',
    ts: new Date().toISOString(),
    command: verb,
    invocationId: INVOCATION_ID,
    pid: process.pid,
  };
  for (const source of [sessionIdentity(env), withLogUrl(extra)]) {
    for (const [k, v] of Object.entries(source)) if (v !== undefined) record[k] = v;
  }
  const line = JSON.stringify(record) + '\n';
  writeToEventFd(line, env);
  try { appendAction(record); } catch { /* best-effort */ }
}

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_KEEP = 3;
const REPEAT_KEYS_MAX = 1000;
export const REPEAT_QUIET_MS = 10 * 60_000;
const repeats = new Map<string, { count: number; last: number }>();

export function appendDaemonLog(record: Record<string, unknown>): void {
  const file = getBrowserDaemonLogPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  } catch { /* logging must not fail the daemon */ }
}

export function rotateDaemonLog(maxBytes = DAEMON_LOG_MAX_BYTES, keep = DAEMON_LOG_KEEP): void {
  const file = getBrowserDaemonLogPath();
  try {
    if (fs.statSync(file).size <= maxBytes) return;
  } catch {
    return;
  }
  for (let i = keep; i >= 1; i--) {
    try { fs.renameSync(i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`); } catch { /* generation absent */ }
  }
}

/** A failure repeating (same event, task, profile, error) logs at 1, 10, 100… with `count`; 10 quiet minutes reset it. */
export function emit(event: string, payload: Record<string, unknown> = {}): void {
  payload = withLogUrl(payload);
  if (typeof payload.error === 'string') {
    const key = JSON.stringify([event, payload.task, payload.profile, payload.error]);
    if (repeats.size >= REPEAT_KEYS_MAX && !repeats.has(key)) repeats.clear();
    const now = Date.now();
    const seen = repeats.get(key);
    const count = seen && now - seen.last < REPEAT_QUIET_MS ? seen.count + 1 : 1;
    repeats.set(key, { count, last: now });
    if (count > 1) {
      if (!/^10+$/.test(String(count))) return;
      payload = { ...payload, count };
    }
  }
  appendDaemonLog({ event, ...payload });
}
