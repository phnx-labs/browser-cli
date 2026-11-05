import * as fs from 'node:fs';

export interface HostTarget {
  alias?: string;
  host: string;
  user?: string;
  hostname?: string;
  platform?: string;
  sshArgs?: string[];
}

export interface BrowserContext {
  version: number;
  target?: HostTarget;
  session?: { sessionId?: string; launchId?: string; actor?: string };
  remoteControl?: { allowed?: boolean };
}

export const CONTEXT_FD_ENV = 'BROWSER_CONTEXT_FD';

let cached: BrowserContext | null | undefined;

export function parseContext(raw: string): BrowserContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`browser context is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('browser context must be a JSON object');
  }
  const ctx = parsed as BrowserContext;
  if (ctx.version !== 1) {
    throw new Error(`unsupported browser context version ${JSON.stringify(ctx.version)} (this build speaks version 1)`);
  }
  if (ctx.target !== undefined && (!ctx.target || typeof ctx.target !== 'object' || Array.isArray(ctx.target) || typeof ctx.target.host !== 'string' || !ctx.target.host.trim())) {
    throw new Error('browser context target.host must be a string');
  }
  if (ctx.session !== undefined) {
    const session = ctx.session as Record<string, unknown> | null;
    if (!session || typeof session !== 'object' || Array.isArray(session)
      || ['sessionId', 'launchId', 'actor'].some((k) => session[k] != null && typeof session[k] !== 'string')) {
      throw new Error('browser context session must be an object of string sessionId, launchId and actor');
    }
  }
  return ctx;
}

function readContextSource(env: NodeJS.ProcessEnv): string | null {
  const rawFd = env[CONTEXT_FD_ENV];
  if (rawFd === undefined) return null;
  const fd = Number(rawFd);
  if (!Number.isInteger(fd) || fd < 3) {
    throw new Error(`${CONTEXT_FD_ENV} must be a file descriptor number, got ${JSON.stringify(rawFd)}`);
  }
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(64 * 1024);
  const deadline = Date.now() + 10000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let size = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out reading browser context');
    let n: number;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 1); continue; }
      throw err;
    }
    if (n <= 0) break;
    size += n;
    if (size > 1024 * 1024) throw new Error('Browser context exceeds 1 MiB');
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function loadContext(env: NodeJS.ProcessEnv = process.env): BrowserContext | null {
  if (cached !== undefined) return cached;
  const raw = readContextSource(env);
  cached = raw === null ? null : parseContext(raw);
  return cached;
}

export function resetContextCache(): void {
  cached = undefined;
}

export function resolveContextDevice(alias: string, env: NodeJS.ProcessEnv = process.env): HostTarget | null {
  const ctx = loadContext(env);
  if (!ctx) return null;
  if (ctx.target && (ctx.target.alias === alias || ctx.target.host === alias)) return { alias, ...ctx.target };
  return null;
}
