import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserServiceDir } from '../runtime/state.js';

export interface EditorWindow {
  id: string;
  app: string;
  appVersion: string;
  workspace: string | null;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  name: string;
}

export type EditorDiscoveryResult =
  | { ok: true; windows: EditorWindow[] }
  | { ok: false; kind: 'invalid'; reason: string };

export function editorEndpointsDir(): string {
  return path.join(getBrowserServiceDir(), 'editors');
}

const APP_SLUGS: Record<string, string> = {
  'visual studio code': 'vscode',
  'visual studio code - insiders': 'vscode-insiders',
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function appSlug(app: string): string {
  return APP_SLUGS[app.toLowerCase()] ?? (slugify(app) || 'editor');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseEndpointFile(file: string): Omit<EditorWindow, 'name'> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return error instanceof SyntaxError ? 'not valid JSON' : (error as Error).message;
  }
  const r = parsed as Record<string, unknown>;
  if (!r || typeof r !== 'object' || r.v !== 1) return 'unsupported version';
  const fields = {
    id: r.id, app: r.app, appVersion: r.appVersion, pid: r.pid, port: r.port, token: r.token, startedAt: r.startedAt,
  };
  if (typeof fields.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(fields.id)) return 'missing id';
  if (typeof fields.app !== 'string' || !fields.app) return 'missing app';
  if (typeof fields.pid !== 'number' || !Number.isInteger(fields.pid) || fields.pid <= 0) return 'missing pid';
  if (typeof fields.port !== 'number' || !Number.isInteger(fields.port) || fields.port <= 0 || fields.port > 65535) return 'missing port';
  if (typeof fields.token !== 'string' || !/^[a-f0-9]{32,128}$/.test(fields.token)) return 'missing token';
  return {
    id: fields.id,
    app: fields.app,
    appVersion: typeof fields.appVersion === 'string' ? fields.appVersion : '',
    workspace: typeof r.workspace === 'string' && r.workspace ? r.workspace : null,
    pid: fields.pid,
    port: fields.port,
    token: fields.token,
    startedAt: typeof fields.startedAt === 'string' ? fields.startedAt : '',
  };
}

export function discoverEditorWindowsAt(dir: string): EditorDiscoveryResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, windows: [] };
    return { ok: false, kind: 'invalid', reason: (error as Error).message };
  }
  const live: Array<Omit<EditorWindow, 'name'>> = [];
  for (const entry of entries) {
    const parsed = parseEndpointFile(path.join(dir, entry));
    if (typeof parsed === 'string' || !isPidAlive(parsed.pid)) continue;
    live.push(parsed);
  }
  live.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const base = (w: Omit<EditorWindow, 'name'>) => `${appSlug(w.app)}-${slugify(w.workspace ?? '') || 'window'}`;
  const counts = new Map<string, number>();
  for (const w of live) counts.set(base(w), (counts.get(base(w)) ?? 0) + 1);
  const windows = live.map((w) => ({
    ...w,
    name: (counts.get(base(w)) ?? 0) > 1 ? `${base(w)}-${w.id.slice(0, 6).toLowerCase()}` : base(w),
  }));
  return { ok: true, windows };
}

export function discoverEditorWindows(): EditorDiscoveryResult {
  return discoverEditorWindowsAt(editorEndpointsDir());
}

export function editorWindowLabel(w: Pick<EditorWindow, 'app' | 'workspace'>): string {
  return w.workspace ? `${w.app} window "${w.workspace}"` : `${w.app} window (no folder)`;
}

export function resolveEditorWsUrl(id: string, profileName: string): string {
  const found = discoverEditorWindows();
  if (!found.ok) throw new Error(`Cannot read editor windows: ${found.reason}`);
  const w = found.windows.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!w) {
    throw new Error(
      `The editor window behind profile "${profileName}" is no longer open. ` +
        `Run \`browser profiles list\` to see the open editor windows.`,
    );
  }
  return `ws://127.0.0.1:${w.port}/devtools/browser/${w.token}`;
}
