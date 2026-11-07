import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { IS_WINDOWS, ipcEndpoint } from '../runtime/platform.js';
import { assertBrowserHomeReady, getBrowserDaemonLogPath, getBrowserServiceLogPath, getBrowserSocketPath } from '../runtime/state.js';
import { emit, emitBrowserAction } from '../runtime/events.js';
import { resolveBrowserTaskIdleMs } from '../runtime/device-config.js';
import { BrowserService } from './service.js';
import {
  isDaemonRunning,
  startDaemon,
  stopBrowserServiceProcess,
} from '../runtime/service.js';
import { getCliVersion } from '../version.js';
import { compareVersions } from '../runtime/semver.js';
import { isFleetRemoteInvocation } from './remote-control.js';
import { resolveCallerIdentity } from './caller-identity.js';
import { actionable } from './service.js';
import type { IPCRequest, IPCResponse, RefNodeJson } from './types.js';

/** Only page verbs may create tasks; observation-only verbs resolve without opening a browser. */
const PAGE_CREATE_VERBS = new Set<IPCRequest['action']>([
  'navigate',
  'tab-add',
  'evaluate',
  'text',
  'screenshot',
  'pdf',
  'refs',
  'click',
  'type',
  'select',
  'press',
  'hover',
  'scroll',
  'set-viewport',
  'set-device',
  'wait',
  'set-download-path',
  'wait-download',
  'upload',
  'record-start',
]);

/** Task-scoped verbs that resolve identity but never create. */
const PAGE_RESOLVE_VERBS = new Set<IPCRequest['action']>([
  ...PAGE_CREATE_VERBS,
  'dialog',
  'tab-focus',
  'tab-close',
  'tab-list',
  'console',
  'errors',
  'requests',
  'response-body',
  'record-stop',
]);

/** Close verbs never create a task. */
const CLOSE_VERBS = new Set<IPCRequest['action']>(['done', 'stop']);

/** Verbs that still work while the page is showing a confirm() or prompt(). */
const DIALOG_FREE_VERBS = new Set<IPCRequest['action']>(['dialog', 'done', 'stop', 'tab-list', 'tab-close', 'screenshot']);

function askingNote(asking: string): string {
  return `The page is asking: ${asking}. Answer it with \`browser dialog accept\` or \`browser dialog dismiss\` (a prompt takes --text <reply>).`;
}

/** `BROWSER_TRACE=1` on the daemon logs per-request and per-CDP-call timings to its log. */
const TRACE = process.env.BROWSER_TRACE === '1';

interface SocketIdentity {
  dev: number;
  ino: number;
}

function readSocketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const stat = fs.lstatSync(socketPath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function isSameSocket(socketPath: string, expected: SocketIdentity): boolean {
  const current = readSocketIdentity(socketPath);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

/** Keep this backstop below STOP_GRACE_MS so releasing held sockets cannot force a graceful stop into a
 * kill. */
const IPC_CLOSE_TIMEOUT_MS = 1_500;

/** Allow service restarts to settle; consecutive successful probes below establish readiness. */
const SOCKET_WAIT_TIMEOUT_MS = 15_000;

/** Require consecutive accepts to avoid declaring a listener ready while it is restarting. */
const SOCKET_WAIT_STABLE_PROBES = 2;

/** A kernel-level connect can succeed with a blocked event loop; readiness requires a version reply. */
const RESPONSIVENESS_PROBE_TIMEOUT_MS = 1_500;

/** Retry missed replies so a transient GC pause does not condemn a reachable daemon. */
const RESPONSIVENESS_PROBE_ATTEMPTS = 3;

/** Recognize cold-start connect errors, including EINVAL from long socket paths with missing
 * directories. */
export function isServiceUnavailable(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EINVAL';
}

function wedgedDaemonError(endpoint: string): Error {
  return new Error(
    actionable(
      'Browser service is running but unresponsive — the shared daemon event loop is blocked, so it accepts the connection but never replies.',
      `Endpoint: ${endpoint}`,
      `Log: ${getBrowserDaemonLogPath()}`,
      'Next: browser stop --service',
    ),
  );
}

export interface IPCRequestOptions {
  autoStartDaemon?: boolean;
  /** Optional deadline for requests with a fixed budget. */
  timeoutMs?: number;
}

type PendingIPCResponse = {
  resolve: (response: IPCResponse) => void;
  reject: (error: Error) => void;
};

export class BrowserServiceNotRunningError extends Error {
  constructor() {
    super(formatBrowserServiceNotRunningError());
    this.name = 'BrowserServiceNotRunningError';
  }
}

export function formatBrowserServiceNotRunningError(
  _daemonRunning: boolean = isDaemonRunning(),
): string {
  return [
    'Browser service is not running.',
    'Start it with: browser start',
    'Pick / pin a profile: browser use <name>  (or: browser start --profile <name>)',
    'List profiles: browser profiles list',
  ].join('\n');
}

export function getSocketPath(): string {
  return getBrowserSocketPath();
}

/** Return the POSIX socket or Windows named pipe; Windows uses getSocketPath only as a stable naming
 * key. */
function getIpcEndpoint(): string {
  return ipcEndpoint(getSocketPath());
}

/** Return whether the daemon accepts a connection, distinguishing live listeners from stale socket
 * files. */
function probeBrowserService(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

/** Is the daemon reachable? A real connect probe on every platform — a socket
 * file existing on disk is not proof a daemon is listening on it. */
export async function isBrowserServiceReachable(): Promise<boolean> {
  return probeBrowserService(getIpcEndpoint());
}

/** Require a parseable version reply within timeoutMs; return false on connect, parse, timeout or close
 * failure. */
function probeBrowserServiceResponsive(endpoint: string, timeoutMs = RESPONSIVENESS_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let buffer = '';
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { sock.write(JSON.stringify({ action: 'version' }) + '\n'); });
    sock.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      try {
        const resp = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        finish(resp.ok === true);
      } catch {
        finish(false);
      }
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

/** Return true on any responsive probe; only repeated misses classify a reachable daemon as wedged. */
export async function isBrowserServiceResponsive(
  endpoint: string = getIpcEndpoint(),
  attempts: number = RESPONSIVENESS_PROBE_ATTEMPTS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeBrowserServiceResponsive(endpoint)) return true;
  }
  return false;
}

/** Wait for consecutive accepts across service restarts; throw with the endpoint and budget on timeout. */
export async function waitForBrowserService(
  _socketPath: string,
  timeoutMs: number = SOCKET_WAIT_TIMEOUT_MS,
): Promise<void> {
  const endpoint = getIpcEndpoint();
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await probeBrowserService(endpoint)) {
      consecutive += 1;
      if (consecutive >= SOCKET_WAIT_STABLE_PROBES) return;
    } else {
      // A dropped probe means a restart (or the daemon isn't up yet) — start the
      // stability count over rather than counting accepts from before the gap.
      consecutive = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timeout waiting for browser service socket after ${Math.round(timeoutMs / 1000)}s (${endpoint}).`,
  );
}

/** Outcome of {@link stopBrowserService} — what the service-scoped stop did. */
export interface BrowserServiceStopResult {
  /** The browser IPC service was reachable before the stop was requested. */
  wasRunning: boolean;
  /** The shared daemon stayed running while only browser IPC was stopped. */
  daemonRunning: boolean;
  /** A leftover `browser.sock` file was unlinked (POSIX only). */
  socketCleared: boolean;
}

/** How long {@link stopBrowserService} waits for the endpoint to go quiet after
 * signalling the daemon-owned service transition. Bounded so a wedged daemon
 * fails loud instead of leaving the client hung on a control request. */
const SERVICE_STOP_QUIESCE_MS = 5_000;

/** Stop the service with SIGTERM and remove a stale socket once quiet; fail without SIGKILL if still
 * reachable. */
export async function stopBrowserService(): Promise<BrowserServiceStopResult> {
  const endpoint = getIpcEndpoint();
  const wasRunning = await probeBrowserService(endpoint);
  stopBrowserServiceProcess();

  const deadline = Date.now() + SERVICE_STOP_QUIESCE_MS;
  let reachable = wasRunning;
  while (reachable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reachable = await probeBrowserService(endpoint);
  }

  if (reachable) {
    throw new Error(
      actionable(
        'Browser service is still reachable after its stop request.',
        `Endpoint: ${endpoint}`,
        'Next: browser stop --service',
      ),
    );
  }

  // Nothing is listening now — clear the leftover socket file a hard-crashed
  // daemon left behind, so the next `start` binds clean instead of unlinking it
  // blindly. (Named pipes vanish with their owning process, so Windows has no
  // stale file to clear.)
  const socketCleared = IS_WINDOWS ? false : await clearDeadSocketFile(endpoint, getSocketPath());

  return { wasRunning, daemonRunning: isDaemonRunning(), socketCleared };
}

/** Re-probe immediately before unlinking to narrow the race with a new listener; return true only if
 * removed. */
export async function clearDeadSocketFile(endpoint: string, socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  // A listener bound again since the quiesce loop → do not touch its socket.
  if (await probeBrowserService(endpoint)) return false;
  try {
    fs.unlinkSync(socketPath);
    return true;
  } catch {
    // Raced with a fresh start that already claimed it — the goal (no stale
    // socket) still holds, so report cleared only when it is genuinely gone.
    return !fs.existsSync(socketPath);
  }
}

/** Serialize requests on one warm connection so each newline-delimited reply reaches its caller. */
export class BrowserIPCConnection {
  private buffer = '';
  private pending: PendingIPCResponse | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (data) => this.handleData(data));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      this.fail(new Error('Browser service connection closed'));
    });
  }

  request(request: IPCRequest): Promise<IPCResponse> {
    const stamped = stampCallerIdentity(request);
    const result = this.tail
      .then(() => logAction(stamped, () => this.requestOnce(stamped)))
      .then((response) => {
        if (stamped.action !== 'version') reconcileDaemonVersion(response.version);
        return response;
      });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.closed || this.socket.destroyed) return;

    await new Promise<void>((resolve) => {
      this.socket.once('close', resolve);
      this.socket.end();
    });
  }

  private requestOnce(request: IPCRequest): Promise<IPCResponse> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error('Browser service connection is closed'));
    }

    return new Promise<IPCResponse>((resolve, reject) => {
      // Same wedged-daemon watchdog as sendOverNewSocket: a
      // request that has waited a full probe window without a reply asks a
      // second connection whether the daemon answers at all, and fails loud
      // when it does not instead of hanging the stream forever.
      const endpoint = getIpcEndpoint();
      const watchdog = setTimeout(() => {
        void isBrowserServiceResponsive(endpoint).then((responsive) => {
          if (responsive || this.pending !== pending) return;
          this.socket.destroy();
          this.fail(wedgedDaemonError(endpoint));
        });
      }, RESPONSIVENESS_PROBE_TIMEOUT_MS);
      const done = <T>(fn: (v: T) => void) => (v: T) => { clearTimeout(watchdog); fn(v); };
      const pending: PendingIPCResponse = { resolve: done(resolve), reject: done(reject) };
      this.pending = pending;
      this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        if (this.pending === pending) this.pending = undefined;
        pending.reject(error);
      });
    });
  }

  private handleData(data: Buffer | string): void {
    this.buffer += data.toString();

    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;

      const pending = this.pending;
      if (!pending) {
        this.socket.destroy();
        this.fail(new Error('Browser service sent an unexpected response'));
        return;
      }

      this.pending = undefined;
      try {
        pending.resolve(JSON.parse(line) as IPCResponse);
      } catch {
        const error = new Error('Browser service returned invalid JSON');
        pending.reject(error);
        this.socket.destroy();
        this.fail(error);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

export class BrowserIPCServer {
  private server: net.Server | null = null;
  /** Filesystem identity of the POSIX binding this server created. */
  private socketIdentity: SocketIdentity | null = null;
  private service: BrowserService;
  /** Live client connections, so {@link stop} can end them rather than wait. */
  private connections = new Set<net.Socket>();
  /** In-flight stop, so a second SIGTERM awaits the same close, never skips it. */
  private stopping: Promise<void> | null = null;
  /** Test-only POSIX socket override prevents tests from unlinking the user's shared daemon socket. */
  private readonly socketPathOverride?: string;
  constructor(service: BrowserService, socketPathOverride?: string) {
    this.service = service;
    this.socketPathOverride = socketPathOverride;
  }

  async start(): Promise<void> {
    const socketPath = this.socketPathOverride ?? getSocketPath();
    // On POSIX the endpoint IS the socket path; an override addresses the same
    // isolated file. (Windows keeps its derived pipe name; the override is
    // POSIX-only test machinery.)
    const endpoint = this.socketPathOverride ?? getIpcEndpoint();
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

    if (!IS_WINDOWS) {
      fs.chmodSync(socketDir, 0o700);
      // Remove a stale unix socket from a prior crash. (Named pipes are not
      // filesystem objects and vanish with their owning process.)
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }

    this.server = net.createServer((socket) => {
      // `net.Server.close()` stops accepting but does not complete until every
      // EXISTING connection ends, and clients here hold one open on purpose
      // ("the process and socket stay warm between actions"). Tracking them is
      // what lets stop() end them deliberately instead of waiting out a timeout.
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));

      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          let request: IPCRequest | undefined;
          try {
            request = JSON.parse(line) as IPCRequest;
            const t0 = performance.now();
            const response = await this.handleRequest(request);
            if (TRACE) fs.writeSync(2, `[trace] ipc ${request.action} ${(performance.now() - t0).toFixed(1)}ms\n`);
            // Every reply carries the daemon's version so a client can notice
            // skew from the reply it already has, with no extra probe.
            const dialogs = this.dialogsFor(response.task ?? request.task);
            socket.write(JSON.stringify({ ...response, ...(dialogs.length ? { dialogs } : {}), version: response.version ?? getCliVersion() }) + '\n');
          } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            const dialogs = this.dialogsFor(request?.task);
            socket.write(JSON.stringify({ ok: false, error, ...(dialogs.length ? { dialogs } : {}) }) + '\n');
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected
      });
    });

    return new Promise((resolve, reject) => {
      if (IS_WINDOWS) {
        // Windows named pipe: no umask/chmod — filesystem perms don't apply and
        // pipe ACLs default to the creating user.
        this.server!.listen(endpoint, () => resolve());
        this.server!.on('error', (err) => reject(err));
        return;
      }
      // Lock down the browser socket dir before opening the socket; on macOS
      // the parent dir is the real local-user boundary for AF_UNIX sockets.
      const prevUmask = process.umask(0o077);
      let restored = false;
      const restoreUmask = () => {
        if (restored) return;
        restored = true;
        process.umask(prevUmask);
      };
      this.server!.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
          this.socketIdentity = readSocketIdentity(socketPath);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          restoreUmask();
        }
      });
      this.server!.on('error', (err) => {
        restoreUmask();
        reject(err);
      });
    });
  }

  /** Resolve after releasing the binding; destroy held connections so close completes before SIGTERM
   * grace expires. */
  async stop(): Promise<void> {
    // A second SIGTERM must await the SAME stop, not skip past it because
    // `this.server` was already nulled by the first.
    if (!this.stopping) this.stopping = this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    const socketPath = getSocketPath();
    const owned = this.socketIdentity;
    let preservedReplacement: string | null = null;

    if (!IS_WINDOWS && owned && readSocketIdentity(socketPath) && !isSameSocket(socketPath, owned)) {
      // libuv unlinks the listen pathname during close; move a successor's socket aside and restore it
      // afterward.
      preservedReplacement = `${socketPath}.preserved-${process.pid}-${Date.now()}`;
      fs.renameSync(socketPath, preservedReplacement);
    }

    try {
      await this.closeServer();
    } finally {
      if (preservedReplacement && fs.existsSync(preservedReplacement) && !fs.existsSync(socketPath)) {
        fs.renameSync(preservedReplacement, socketPath);
      }
    }

    if (!IS_WINDOWS) {
      this.socketIdentity = null;
      if (owned && isSameSocket(socketPath, owned)) {
        fs.unlinkSync(socketPath);
      }
    }

    await this.service.shutdown();
  }

  /** Release the listening binding, resolving only once it is genuinely gone. */
  private closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      // Backstop only, for a socket that refuses to die. Far below the daemon's
      // SIGTERM grace window so a slow close can never be what gets the daemon
      // killed — the whole point is that the graceful path stays graceful.
      const timer = setTimeout(done, IPC_CLOSE_TIMEOUT_MS);
      // `close()` reports an error when the server was never listening —
      // nothing to release, so that is a completed close, not a failure.
      server.close(() => done());
      // `close()` waits for existing connections; ending them is what lets it
      // finish now instead of at the timeout.
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
    });
  }

  /** Bind an omitted task from caller identity; page verbs may create, done/stop never do. Return
   * errors early. */
  private async bindTask(
    request: IPCRequest,
  ): Promise<IPCResponse | undefined> {
    const createIfMissing = PAGE_CREATE_VERBS.has(request.action);
    const isClose = CLOSE_VERBS.has(request.action);

    // Clear client-supplied bind state so only resolver-derived firstOpen values can control tab
    // reuse.
    delete request.firstOpen;

    // stop with --profile only (no task) is handled by the stop case itself.
    if (request.action === 'stop' && request.profile && !request.task) return undefined;

    try {
      const resolved = await this.service.resolveOrCreateTask({
        task: request.task,
        profile: request.profile,
        actor: request.actor,
        launchId: request.launchId,
        sessionId: request.sessionId,
        fleetRemote: request.fleetRemote,
        createIfMissing,
        title: request.title,
        url: request.url,
      });
      if (!resolved) {
        if (isClose) {
          return { ok: true, message: 'nothing to close' };
        }
        return {
          ok: false,
          error: actionable(
            'No browser task for this session.',
            'Next: browser navigate <url>  |  browser start',
          ),
        };
      }
      request.task = resolved.task.name;
      // The implicit create already opened request.url on this tab. Carry the
      // ACTUAL page result so the navigate/tab-add handler reports that first
      // open honestly (created/refreshed as it happened) instead of executing
      // the URL a second time.
      if (resolved.created && resolved.firstOpen) {
        request.firstOpen = resolved.firstOpen;
      }
      return undefined;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private dialogsFor(task: string | undefined): string[] {
    if (!task) return [];
    try {
      return this.service.takeDialogs(task);
    } catch {
      return [];
    }
  }

  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
    if ((request.action as string) === 'upload-stage') {
      const source = (request as IPCRequest & { source?: string }).source;
      if (!source) {
        return { ok: false, error: 'Source required' };
      }
      const result = this.service.stageUpload(source);
      return { ok: true, path: result.path };
    }

    // Task-scoped actions: resolve identity / create / refuse once here.
    if (PAGE_RESOLVE_VERBS.has(request.action) || CLOSE_VERBS.has(request.action)) {
      const tb = performance.now();
      const early = await this.bindTask(request);
      if (TRACE) fs.writeSync(2, `[trace] bind ${request.action} ${(performance.now() - tb).toFixed(1)}ms\n`);
      if (early) return early;
      // A confirm() or prompt() freezes the page until answered; say so at once
      // instead of letting the verb hang on it.
      const asking = request.task && !DIALOG_FREE_VERBS.has(request.action) ? this.service.openDialog(request.task) : undefined;
      if (asking) return { ok: false, error: askingNote(asking) };
    }

    switch (request.action) {
      case 'version': {
        return { ok: true, version: getCliVersion() };
      }

      case 'show': {
        // Task-less by design — see BrowserService.showUrl. Absent from both
        // PAGE_CREATE_VERBS and PAGE_RESOLVE_VERBS, so bindTask never ran above
        // and this request carries no task.
        if (!request.url) {
          return { ok: false, error: actionable('URL required.', 'Next: browser navigate <url>') };
        }
        if (!request.profile) {
          return { ok: false, error: actionable('Profile required.', 'Next: browser profiles list') };
        }
        const shown = await this.service.showUrl(request.profile, request.url, {
          fleetRemote: request.fleetRemote,
          actor: request.actor,
          fresh: request.fresh,
        });
        return { ok: true, tabId: shown.tabId, created: !shown.reused, refreshed: shown.reused };
      }

      case 'start': {
        if (!request.profile) {
          return { ok: false, error: actionable('Profile required.', 'Next: browser profiles list') };
        }
        const result = await this.service.start(request.profile, {
          taskName: request.taskName,
          url: request.url,
          endpointName: request.endpoint,
          fresh: request.fresh,
          actor: request.actor,
          launchId: request.launchId,
          sessionId: request.sessionId,
          fleetRemote: request.fleetRemote,
          title: request.title,
        });
        // Task reuse and page refresh are distinct: no-URL retries must not report a reload that never
        // happened.
        const startReuseNote =
          result.reused && !result.firstOpen?.refreshed && !result.firstOpen?.created
            ? 'Reused existing task'
            : undefined;
        const startSnapshot = request.snapshot && result.tabId
          ? await this.service.snapshot(result.name, result.tabId)
          : undefined;
        return {
          ok: true,
          task: result.name,
          tabId: result.tabId,
          snapshot: startSnapshot,
          windowTargetId: result.windowId,
          reused: result.reused,
          created: result.firstOpen?.created,
          refreshed: result.firstOpen?.refreshed,
          message: [result.firstOpen?.message, startReuseNote].filter(Boolean).join(' · ') || undefined,
        };
      }

      // The out-of-process seam onto the abandoned-task reaper: the daemon
      // owns the live BrowserService, so a CLI verb (`browser prune`) can
      // only reach `reapAbandoned` through IPC. The daemon's own periodic tick
      // calls the service method directly.
      case 'gc': {
        // 0 is the "disable idle reaping" signal (browser.task-idle-minutes),
        // not a zero-ms window — translate it to reapAbandoned's `null` rather
        // than let it hit the idleMs<=0 guard. Omitting the flag falls back to
        // this box's own configured default (or 30 minutes when unset).
        const idleMs =
          request.idleMinutes !== undefined
            ? (request.idleMinutes === 0 ? null : request.idleMinutes * 60_000)
            : await resolveBrowserTaskIdleMs();
        const reaped = await this.service.reapAbandoned({ idleMs, dryRun: request.dryRun });
        return { ok: true, reaped };
      }

      case 'done': {
        if (!request.task) {
          return { ok: true, message: 'nothing to close' };
        }
        const result = await this.service.done(request.task);
        return {
          ok: result.ok,
          error: result.ok
            ? undefined
            : actionable(
                `Task "${request.task}" not found.`,
                'Next: browser status',
              ),
          task: result.ok ? request.task : undefined,
        };
      }

      case 'stop': {
        if (request.task) {
          const result = await this.service.stop(request.task);
          return {
            ok: result.ok,
            error: result.ok
              ? undefined
              : actionable(
                  `Task "${request.task}" not found.`,
                  'Next: browser status',
                ),
            task: result.ok ? request.task : undefined,
          };
        }
        if (request.profile) {
          try {
            await this.service.stopProfile(request.profile, {
              fleetRemote: request.fleetRemote,
              actor: request.actor,
            });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          return { ok: true };
        }
        return {
          ok: false,
          error: actionable(
            'Task or profile required.',
            'Next: browser status  |  browser stop --profile <name>',
          ),
        };
      }

      case 'status': {
        const profiles = await this.service.status(request.profile);
        return { ok: true, profiles };
      }

      case 'history': {
        const history = await this.service.getHistory(request.limit ?? 10);
        return { ok: true, history };
      }

      case 'navigate': {
        if (!request.url) {
          return {
            ok: false,
            error: actionable(
              'URL required.',
              'Next: browser navigate <url>',
            ),
          };
        }
        if (!request.task) {
          return {
            ok: false,
            error: actionable(
              'No browser task for this session.',
              'Next: browser navigate <url>  |  browser start',
            ),
          };
        }
        // The implicit create already opened this URL on this tab. Report the
        // ACTUAL first-open result (adopt → created:false, fresh → created:true)
        // instead of re-navigating it or assuming a create.
        const firstOpen = request.firstOpen;
        if (firstOpen) {
          return {
            ok: true,
            tabId: firstOpen.tabId,
            task: request.task,
            created: firstOpen.created,
            refreshed: firstOpen.refreshed,
            message: firstOpen.message,
          };
        }
        const result = await this.service.navigate(
          request.task,
          request.url,
          request.profile,
          { snapshot: request.snapshot, wait: request.wait !== false },
        );
        return {
          ok: true,
          tabId: result.tabId,
          task: request.task,
          created: result.created,
          refreshed: result.refreshed,
          snapshot: result.snapshot,
          message: result.message,
        };
      }

      case 'tab-add': {
        if (!request.task || !request.url) {
          return { ok: false, error: 'Task and URL required' };
        }
        const firstOpen = request.firstOpen;
        if (firstOpen) {
          return {
            ok: true,
            tabId: firstOpen.tabId,
            task: request.task,
            created: firstOpen.created,
            refreshed: firstOpen.refreshed,
            message: firstOpen.message,
          };
        }
        const result = await this.service.tabAdd(request.task, request.url, request.profile);
        return {
          ok: true,
          tabId: result.tabId,
          task: request.task,
          created: result.created,
          refreshed: result.refreshed,
          message: result.message,
        };
      }

      case 'tab-focus': {
        if (!request.task || !request.tabId) {
          return { ok: false, error: 'Task and tabId required' };
        }
        const result = await this.service.tabFocus(request.task, request.tabId);
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-close': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.tabClose(request.task, request.tabId);
        return { ok: true };
      }

      case 'tab-list': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        if (request.all) {
          const tabs = await this.service.profileTabs(request.task);
          return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, current: t.current, task: t.task })) };
        }
        const tabs = await this.service.tabList(request.task);
        // Carry `current` through — it is the one field a caller needs to show
        // which tab URL-less verbs act on, and dropping it here left `agents
        // browser tabs` unable to mark the selection.
        return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, current: t.current, task: request.task! })) };
      }

      case 'text': {
        if (!request.task) return { ok: false, error: 'Task required' };
        const select = request.css ? { css: request.css, attr: request.attr } : undefined;
        return { ok: true, result: await this.service.text(request.task, request.tabId, select) };
      }

      case 'evaluate': {
        if (!request.task || !request.expr) {
          return { ok: false, error: 'Task and expression required' };
        }
        const result = await this.service.evaluate(
          request.task,
          request.tabId,
          request.expr
        );
        return { ok: true, result };
      }

      case 'record-start': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStart(request.task, request.tabId, {
            fps: request.fps,
            duration: request.duration,
            maxMb: request.maxMb,
          });
          return { ok: true, path: r.path, fps: r.fps, durationCapSec: r.durationCapSec, maxMb: r.maxMb };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'record-stop': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStop(request.task);
          return { ok: true, path: r.path, bytes: r.bytes, durationMs: r.durationMs, stopReason: r.reason as 'manual' | 'duration-cap' | 'size-cap' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'screenshot': {
        if (!request.task) {
          return {
            ok: false,
            error: actionable(
              'No browser task for this session.',
              'Next: browser navigate <url>  |  browser start',
            ),
          };
        }
        const shot = await this.service.screenshot(
          request.task,
          request.tabId,
          request.path,
          request.quality
        );
        return {
          ok: true,
          path: shot.path,
          bytes: shot.bytes,
          width: shot.width,
          height: shot.height,
          task: request.task,
        };
      }

      case 'pdf': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const doc = await this.service.printToPdf(
          request.task,
          request.tabId,
          request.path
        );
        return { ok: true, path: doc.path, bytes: doc.bytes };
      }

      case 'refs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const { refs, nodeMap } = await this.service.refs(request.task, request.tabId, {
          interactive: request.interactive ?? true,
          limit: request.limit ?? 500,
        });
        const nodes: RefNodeJson[] = Array.from(nodeMap.values()).map(n => {
          const entry: RefNodeJson = { ref: n.ref, role: n.role, name: n.name, attrs: n.attrs };
          if (n.editor !== undefined) entry.editor = n.editor;
          return entry;
        });
        return { ok: true, refs, nodes };
      }

      case 'click': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        // Coordinate click (`--at X,Y`) bypasses ref resolution entirely.
        if (request.atX !== undefined && request.atY !== undefined) {
          const at = await this.service.clickAt(request.task, request.atX, request.atY, request.tabId, {
            snapshot: request.snapshot,
            wait: request.wait !== false,
          });
          if (at.asking) return { ok: true, message: askingNote(at.asking) };
          return { ok: true, snapshot: at.snapshot };
        }
        if (request.text !== undefined) {
          const byName = await this.service.clickByName(request.task, request.text, request.role, request.tabId, {
            snapshot: request.snapshot,
            wait: request.wait !== false,
          });
          const which = byName.matches > 1 ? `${byName.clicked}, first of ${byName.matches} matches` : byName.clicked;
          return {
            ok: true,
            message: byName.asking ? `${which}. ${askingNote(byName.asking)}` : which,
            snapshot: byName.snapshot,
          };
        }
        if (request.ref === undefined) {
          return { ok: false, error: 'Task and ref (or --at X,Y, or --text) required' };
        }
        const { healed, snapshot, chose, asking } = await this.service.click(request.task, request.ref, request.tabId, {
          snapshot: request.snapshot,
          wait: request.wait !== false,
        });
        if (asking) return { ok: true, message: askingNote(asking) };
        if (chose !== undefined) {
          return { ok: true, message: `selected option "${chose}"`, snapshot };
        }
        if (healed) {
          return {
            ok: true,
            message: healed.renamed !== undefined
              ? `${healed.role} "${healed.name}" now reads "${healed.renamed}"`
              : `self-healed ref ${healed.from} -> ${healed.to} (${healed.role} "${healed.name}")`,
            snapshot,
          };
        }
        return { ok: true, snapshot };
      }

      case 'type': {
        const typeTarget = request.ref ?? request.name;
        if (!request.task || typeTarget === undefined || !request.text) {
          return { ok: false, error: 'Task, ref or name, and text required' };
        }
        const typed = await this.service.type(request.task, typeTarget, request.text, request.tabId, request.clear, {
          snapshot: request.snapshot,
          wait: request.wait !== false,
          secretSite: request.secretSite,
        });
        return {
          ok: true,
          message: typed.reads !== undefined ? `the input now reads "${typed.reads}"` : undefined,
          snapshot: typed.snapshot,
        };
      }

      case 'select': {
        const selectTarget = request.ref ?? request.name;
        if (!request.task || selectTarget === undefined || request.text === undefined) {
          return { ok: false, error: 'Task, ref or name, and option required' };
        }
        const chosen = await this.service.select(request.task, selectTarget, request.text, request.tabId, {
          snapshot: request.snapshot,
          wait: request.wait !== false,
        });
        return { ok: true, result: chosen.selected, snapshot: chosen.snapshot };
      }

      case 'press': {
        if (!request.task || !request.key) {
          return { ok: false, error: 'Task and key required' };
        }
        const pressed = await this.service.press(request.task, request.key, request.tabId, { snapshot: request.snapshot, wait: request.wait !== false });
        if (pressed.asking) return { ok: true, message: askingNote(pressed.asking) };
        return { ok: true, snapshot: pressed.snapshot };
      }

      case 'dialog': {
        if (!request.task) return { ok: false, error: 'Task required' };
        const accept = request.key === 'accept';
        const said = await this.service.answerDialog(request.task, accept, accept ? request.text : undefined);
        // Answering after an alert() that was accepted on its own is a no-op, not a failure.
        if (said === undefined) return { ok: true, message: 'No dialog is open on this task; an alert() is accepted as it appears.' };
        return { ok: true, message: `${accept ? 'Accepted' : 'Dismissed'} ${said}` };
      }

      case 'hover': {
        if (!request.task || request.ref === undefined) {
          return { ok: false, error: 'Task and ref required' };
        }
        await this.service.hover(request.task, request.ref, request.tabId);
        return { ok: true };
      }

      case 'scroll': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.scroll(
          request.task,
          request.scrollX ?? 0,
          request.scrollY ?? 0,
          request.scrollAtX,
          request.scrollAtY,
          request.tabId
        );
        return { ok: true };
      }

      case 'set-viewport': {
        if (!request.task || !request.width || !request.height) {
          return { ok: false, error: 'Task, width, and height required' };
        }
        await this.service.setViewport(request.task, request.width, request.height, {
          mobile: request.mobile,
          deviceScaleFactor: request.deviceScaleFactor,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-device': {
        if (!request.task || !request.deviceName) {
          return { ok: false, error: 'Task and device name required' };
        }
        await this.service.setDevice(request.task, request.deviceName, request.tabId);
        return { ok: true };
      }

      case 'console': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const logs = await this.service.getConsoleLogs(request.task, {
          level: request.level,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, logs };
      }

      case 'errors': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const errors = await this.service.getErrors(request.task, {
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, errors };
      }

      case 'requests': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const requests = await this.service.getNetworkRequests(request.task, {
          filter: request.filter,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, requests };
      }

      case 'response-body': {
        if (!request.task || !request.urlPattern) {
          return { ok: false, error: 'Task and URL pattern required' };
        }
        const body = await this.service.getResponseBody(request.task, request.urlPattern, {
          timeout: request.timeout,
          maxChars: request.maxChars,
          tabHint: request.tabId,
        });
        return { ok: true, body };
      }

      case 'wait': {
        if (!request.task || !request.waitType || request.waitValue === undefined) {
          return { ok: false, error: 'Task, wait type, and wait value required' };
        }
        await this.service.wait(request.task, request.waitType, request.waitValue, {
          timeout: request.timeout,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-download-path': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        // downloadPath optional: omitted → service defaults to the profile's downloads dir.
        const resolved = await this.service.setDownloadPath(request.task, request.downloadPath, request.tabId);
        return { ok: true, downloadPath: resolved };
      }

      case 'wait-download': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const downloadPath = await this.service.waitForDownload(request.task, request.timeout);
        return { ok: true, downloadPath };
      }

      case 'upload': {
        if (!request.task || !request.files || request.files.length === 0) {
          return { ok: false, error: 'Task and at least one file required' };
        }
        const result = await this.service.upload(request.task, request.files, {
          ref: request.ref,
          trigger: request.trigger,
          mode: request.uploadMode,
          tabHint: request.tabId,
          timeout: request.timeout,
        });
        return { ok: true, uploadMode: result.mode };
      }

      default:
        return { ok: false, error: `Unknown action: ${request.action}` };
    }
  }
}

let versionReconciledThisProcess = false;

/** Recommend refresh only for an older daemon or unordered distinct versions; ignore unknown versions. */
export function shouldRecommendDaemonRefresh(
  daemonVersion: string | undefined,
  clientVersion: string
): boolean {
  if (!daemonVersion || daemonVersion === 'unknown') return false;
  if (daemonVersion === clientVersion) return false;
  const cmp = compareVersions(daemonVersion, clientVersion);
  if (cmp < 0) return true; // daemon older than client → upgrade forward
  if (cmp > 0) return false; // daemon newer → older CLI rides it
  // cmp === 0 but strings differ (unorderable tails like 0.0.0-dev.abc)
  return true;
}

export function reconcileDaemonVersion(daemon: string | undefined): void {
  if (versionReconciledThisProcess) return;
  versionReconciledThisProcess = true;

  const client = getCliVersion();
  if (!shouldRecommendDaemonRefresh(daemon, client)) return;
  emit('daemon.version_mismatch', { daemon, cli: client });
  process.stderr.write(`daemon is ${daemon}, CLI is ${client}: run browser stop --service\n`);
}

async function logAction(request: IPCRequest, send: () => Promise<IPCResponse>): Promise<IPCResponse> {
  const started = performance.now();
  const record = (ok: boolean, error?: string, task?: string) => emitBrowserAction(request.action, {
    task: task ?? request.task ?? request.taskName,
    profile: request.profile,
    url: request.url,
    actor: request.actor,
    launchId: request.launchId,
    sessionId: request.sessionId,
    ok,
    error,
    ms: Math.round(performance.now() - started),
  });
  try {
    const response = await send();
    record(response.ok, response.error, response.task);
    return response;
  } catch (err) {
    record(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function sendIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  // Stamp caller identity ONCE here so the 28+ call sites don't each have to.
  // The daemon cannot resolve the caller's actor/session itself.
  const stamped = stampCallerIdentity(request);
  const response = await logAction(stamped, () => sendRawIPCRequest(stamped, opts));
  for (const dialog of response.dialogs ?? []) console.error(`The page showed ${dialog}; it was accepted.`);
  return response;
}

/**
 * Fill actor / launchId / sessionId from the calling process when the request
 * left them blank. Explicit values on the request always win.
 */
export function stampCallerIdentity(
  request: IPCRequest,
  env: NodeJS.ProcessEnv = process.env,
): IPCRequest {
  // Stamp consent before identity's early return; OR the marker so callers cannot clear environment
  // consent.
  const fleetRemote = isFleetRemoteInvocation(env) || request.fleetRemote === true;
  const marked: IPCRequest =
    request.fleetRemote === fleetRemote ? request : { ...request, fleetRemote };

  if (marked.actor && marked.launchId && marked.sessionId) return marked;
  const id = resolveCallerIdentity(env);
  return {
    ...marked,
    actor: marked.actor ?? id.actor,
    launchId: marked.launchId ?? id.launchId,
    sessionId: marked.sessionId ?? id.sessionId,
  };
}

/** Open a reusable service connection with the same startup, version reconciliation and watchdog as
 * sendIPCRequest. */
export async function connectBrowserIPC(
  opts: IPCRequestOptions = {}
): Promise<BrowserIPCConnection> {
  const autoStartDaemon = opts.autoStartDaemon ?? true;
  try {
    return await openIPCSocket();
  } catch (err) {
    if (!autoStartDaemon || !(err instanceof BrowserServiceNotRunningError)) throw err;
    await ensureBrowserService();
    return openIPCSocket();
  }
}

function openIPCSocket(): Promise<BrowserIPCConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getIpcEndpoint());

    const onError = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (isServiceUnavailable(error)) {
        reject(new BrowserServiceNotRunningError());
        return;
      }
      reject(new Error(`IPC error: ${error.message}`));
    };

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(new BrowserIPCConnection(socket));
    });
  });
}

/** Exported to verify the client deadline against a real nonresponding socket server. */
export async function sendRawIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  const autoStartDaemon = opts.autoStartDaemon ?? true;

  // Connect first and start the service only when the connect is refused: the
  // common case (a live daemon) pays exactly one socket round trip. The old
  // shape probed reachability, probed responsiveness and asked for the daemon
  // version before every verb — three extra round trips on every action.
  let response: IPCResponse;
  try {
    response = await sendOverNewSocket(request, opts);
  } catch (err) {
    if (!autoStartDaemon || !(err instanceof BrowserServiceNotRunningError)) throw err;
    await ensureBrowserService();
    response = await sendOverNewSocket(request, opts);
  }

  // Skips the internal `version` probe (avoids recursion) and callers that opt
  // out of auto-start. No-ops once reconciled or when versions match.
  if (request.action !== 'version' && autoStartDaemon) {
    reconcileDaemonVersion(response.version);
  }
  return response;
}

function sendOverNewSocket(
  request: IPCRequest,
  opts: IPCRequestOptions
): Promise<IPCResponse> {
  const endpoint = getIpcEndpoint();
  const autoStartDaemon = opts.autoStartDaemon ?? true;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (watchdog) clearTimeout(watchdog);
      fn();
    };

    if (opts.timeoutMs) {
      deadline = setTimeout(() => {
        settle(() => {
          socket.destroy();
          reject(new Error(`IPC request '${request.action}' timed out after ${opts.timeoutMs}ms`));
        });
      }, opts.timeoutMs);
    }

    // After a delayed request, probe on another connection to distinguish a busy daemon from a blocked
    // event loop.
    if (autoStartDaemon) {
      watchdog = setTimeout(() => {
        void isBrowserServiceResponsive(endpoint).then((responsive) => {
          if (responsive) return;
          settle(() => {
            socket.destroy();
            reject(wedgedDaemonError(endpoint));
          });
        });
      }, RESPONSIVENESS_PROBE_TIMEOUT_MS);
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const response = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        settle(() => {
          socket.end();
          resolve(response);
        });
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (isServiceUnavailable(err)) {
          reject(new BrowserServiceNotRunningError());
          return;
        }
        reject(new Error(`IPC error: ${err.message}`));
      });
    });

    socket.on('close', () => {
      settle(() => {
        if (!buffer.includes('\n')) {
          reject(new Error('Connection closed before response'));
        }
      });
    });
  });
}

/**
 * Bring the browser service up after a refused connect: start it unless one
 * is already starting, then wait until its socket stays up.
 */
async function ensureBrowserService(): Promise<void> {
  assertBrowserHomeReady();
  const socketPath = getSocketPath();
  if (!IS_WINDOWS) {
    await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await fs.promises.chmod(path.dirname(socketPath), 0o700);
  }
  // A live `__serve` refusing the connect is stopping or stuck: wait it out
  // below rather than start a second one. A daemon that is still binding has
  // no pid file yet, and the one it races exits on the service lock.
  if (!isDaemonRunning()) startDaemon();
  if (!(await isBrowserServiceReachable())) {
    await waitForBrowserService(socketPath);
  }
  if (!(await isBrowserServiceReachable())) {
    throw new Error(
      actionable(
        'Failed to start browser service.',
        `Log: ${getBrowserServiceLogPath()}`,
        'Next: browser start',
      ),
    );
  }
  await new Promise((r) => setTimeout(r, 300));
}
