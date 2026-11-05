import type { Readable, Writable } from 'stream';
// The `ws` client, not the platform (undici) WebSocket: undici's fixed max decompressed message
// size kills the socket (code 1006) on a CDP response carrying a large base64 screenshot.
// `ws` has no permessage-deflate by default and takes an explicit payload cap.
import WSWebSocket from 'ws';
import * as fs from 'node:fs';

export interface CDPPipeTransport {
  read: Readable;
  write: Writable;
}

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;
type TransportKind = 'websocket' | 'pipe';

const TRACE = process.env.BROWSER_TRACE === '1';

export class CDPClient {
  private ws: WSWebSocket | null = null;
  private pipe: CDPPipeTransport | null = null;
  private pipeBuffer = Buffer.alloc(0);
  private transport: TransportKind | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private pipeDataHandler: ((chunk: Buffer) => void) | null = null;
  private pipeErrorHandler: ((err: Error) => void) | null = null;
  private pipeCloseHandler: (() => void) | null = null;

  async connect(endpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WSWebSocket(endpoint, { maxPayload: 256 * 1024 * 1024 });
      this.transport = 'websocket';

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket error'));
      this.ws.onclose = () => this.handleClose();
      this.ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  connectPipe(transport: CDPPipeTransport): void {
    this.pipe = transport;
    this.transport = 'pipe';
    this.pipeBuffer = Buffer.alloc(0);

    this.pipeDataHandler = (chunk) => this.handlePipeData(chunk);
    this.pipeErrorHandler = (err) => this.handleClose(err);
    this.pipeCloseHandler = () => this.handleClose();

    transport.read.on('data', this.pipeDataHandler);
    transport.read.on('error', this.pipeErrorHandler);
    transport.read.on('close', this.pipeCloseHandler);
    transport.write.on('error', this.pipeErrorHandler);
    transport.write.on('close', this.pipeCloseHandler);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    if (!this.isOpen) {
      // The browser was killed between the daemon connecting and this call; the healthcheck
      // normally catches that on the next `start`, so tell the user how to recover.
      throw new Error(
        'CDP connection not open — the browser was likely closed externally. ' +
          'Run `browser stop --profile <name>` (or `browser stop --service`) and try again.'
      );
    }

    const id = ++this.messageId;
    const message = sessionId
      ? JSON.stringify({ id, method, params, sessionId })
      : JSON.stringify({ id, method, params });

    const t0 = TRACE ? performance.now() : 0;
    return new Promise((resolve, reject) => {
      const done = (fn: (v: never) => void) => (v: unknown) => {
        if (TRACE) fs.writeSync(2, `[trace] cdp ${method} ${(performance.now() - t0).toFixed(1)}ms\n`);
        fn(v as never);
      };
      this.pending.set(id, { resolve: done(resolve as (r: unknown) => void), reject: done(reject) });
      if (this.transport === 'pipe') {
        this.pipe!.write.write(message + '\0');
      } else {
        this.ws!.send(message);
      }
    });
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pipe) {
      if (this.pipeDataHandler) this.pipe.read.off('data', this.pipeDataHandler);
      if (this.pipeErrorHandler) {
        this.pipe.read.off('error', this.pipeErrorHandler);
        this.pipe.write.off('error', this.pipeErrorHandler);
      }
      if (this.pipeCloseHandler) {
        this.pipe.read.off('close', this.pipeCloseHandler);
        this.pipe.write.off('close', this.pipeCloseHandler);
      }
      this.pipe.write.end();
      this.pipe = null;
    }
    this.transport = null;
  }

  get connected(): boolean {
    return (
      (this.ws !== null && this.ws.readyState === WSWebSocket.OPEN) ||
      (this.pipe !== null && !this.pipe.write.destroyed)
    );
  }

  get isOpen(): boolean {
    return this.connected;
  }

  private handlePipeData(chunk: Buffer): void {
    this.pipeBuffer = Buffer.concat([this.pipeBuffer, chunk]);
    let idx = this.pipeBuffer.indexOf(0);
    while (idx !== -1) {
      const frame = this.pipeBuffer.subarray(0, idx).toString('utf8');
      this.pipeBuffer = this.pipeBuffer.subarray(idx + 1);
      if (frame.length > 0) this.handleMessage(frame);
      idx = this.pipeBuffer.indexOf(0);
    }
  }

  private handleMessage(data: string): void {
    const msg = JSON.parse(data);

    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params || {}, msg.sessionId);
        }
      }
    }
  }

  private handleClose(err?: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err ?? new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.ws = null;
    this.pipe = null;
    this.transport = null;
  }
}

export interface BrowserDiscovery {
  wsUrl: string;
  browser: string;
}

export class BrowserCdpConnectionError extends Error {
  constructor(
    readonly port: number,
    readonly profileName: string = '<name>',
    readonly host = 'localhost'
  ) {
    super(formatBrowserCdpConnectionError(port, profileName, host));
    this.name = 'BrowserCdpConnectionError';
  }
}

export function formatBrowserCdpConnectionError(
  port: number,
  profileName = '<name>',
  host = 'localhost'
): string {
  const target = host === 'localhost' || host === '127.0.0.1'
    ? `port ${port}`
    : `${host}:${port}`;
  return [
    `Could not connect to Chrome on ${target}.`,
    `- Is Chrome running with --remote-debugging-port=${port}?`,
    `- Try: browser start --profile ${profileName}`,
  ].join('\n');
}

export async function discoverBrowserWsUrl(
  port: number,
  host = 'localhost',
  profileName = '<name>'
): Promise<BrowserDiscovery> {
  // Node's fetch has no default timeout — a port that ACKs the TCP connect
  // but never sends an HTTP response will hang here indefinitely. Bound the
  // discovery probe so the caller can surface an actionable error in seconds,
  // not minutes.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
  } catch {
    throw new BrowserCdpConnectionError(port, profileName, host);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new BrowserCdpConnectionError(port, profileName, host);
  }
  const data = (await response.json()) as {
    webSocketDebuggerUrl: string;
    Browser?: string;
    Product?: string;
  };
  const browserField = data.Browser || data.Product || '';
  return {
    wsUrl: data.webSocketDebuggerUrl,
    browser: normalizeBrowserName(browserField),
  };
}

export function normalizeBrowserName(s: string): string {
  if (!s) return 'unknown';
  return s.split('/')[0].trim().toLowerCase().replace(/\s+/g, '-');
}

export function verifyBrowserIdentity(
  reported: string,
  expected: string,
  port: number,
  host = 'localhost'
): void {
  if (expected === 'custom') return;
  if (reported === 'unknown') return;

  const matches: Record<string, string[]> = {
    chrome: ['chrome', 'google-chrome', 'headlesschrome'],
    chromium: ['chromium', 'headlesschrome', 'chrome'],
    // Comet reports itself as plain "Chrome/<version>" in /json/version — it
    // doesn't override the Chromium branding. Accept chrome here so attaching
    // to a Comet instance doesn't trip a false "identity mismatch".
    comet: ['comet', 'chrome'],
    // Arc reports itself as plain "Chrome/<version>" in /json/version (verified
    // live: Arc 1.15x → "Chrome/151"), so accept chrome to avoid a false
    // identity mismatch when attaching to a real Arc.
    arc: ['arc', 'chrome'],
    brave: ['brave', 'brave-browser', 'chrome'],
    // Windows/Chromium Edge reports its /json/version "Browser" field as
    // "Edg/<version>" (the `Edg` token, not `Edge`), which normalizeBrowserName
    // reduces to "edg". Accept it so attaching to a real Edge doesn't trip a
    // false identity mismatch (the profile enum only allows "edge").
    edge: ['edge', 'edg', 'microsoft-edge', 'msedge', 'chrome'],
  };

  const accepted = matches[expected] || [expected];
  if (accepted.includes(reported)) return;

  const target = host === 'localhost' || host === '127.0.0.1' ? `port ${port}` : `${host}:${port}`;
  throw new Error(
    `Browser identity mismatch: profile expects "${expected}" but ${target} is serving "${reported}". ` +
      `Stop the running browser (e.g. \`pkill -f ${reported}\`) or update the profile to browser=${reported}, then retry.`
  );
}
