import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface App { name: string; bundleId: string }

export interface Seen {
  /** True only when confirmed: the tab is selected in its app's front window and that app is in front. */
  visible: boolean;
  frontmost: string;
  notification: 'clickable' | 'plain' | 'none';
  unknownWhy?: string;
}

export function isVisible(viewer: App | undefined, inFront: boolean, front: App | undefined): boolean {
  return viewer !== undefined && front !== undefined && inFront && front.bundleId === viewer.bundleId;
}

const FRONTMOST_JXA = `const front = Application('System Events').applicationProcesses.whose({ frontmost: true })();
front.length === 0 ? 'null' : JSON.stringify({ name: front[0].name(), bundleId: front[0].bundleIdentifier() });`;

async function frontmostApp(): Promise<App | null> {
  const { execAppleScript } = await import('../browser/drivers/arc.js');
  return JSON.parse(await execAppleScript(FRONTMOST_JXA, 5_000, 'JavaScript')) as App | null;
}

export async function handlerApp(target: string): Promise<App | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const { execAppleScript } = await import('../browser/drivers/arc.js');
  const url = path.isAbsolute(target) ? `$.NSURL.fileURLWithPath(${JSON.stringify(target)})` : `$.NSURL.URLWithString(${JSON.stringify(target)})`;
  const raw = await execAppleScript(`ObjC.import('AppKit');
const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(${url});
if (app.isNil()) { 'null' } else {
  const bundle = $.NSBundle.bundleWithURL(app);
  JSON.stringify({ name: ObjC.unwrap(app.lastPathComponent).replace(/\\.app$/, ''), bundleId: ObjC.unwrap(bundle.bundleIdentifier) });
}`, 5_000, 'JavaScript').catch(() => 'null');
  return (JSON.parse(raw) as App | null) ?? undefined;
}

const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

export function findNotifier(pathEnv = process.env.PATH ?? ''): string | undefined {
  for (const dir of [...pathEnv.split(path.delimiter).filter(Boolean), ...HOMEBREW_BIN_DIRS]) {
    const candidate = path.join(dir, 'terminal-notifier');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { continue; }
  }
  return undefined;
}

export function pageLabel(title: string, target: string): string {
  if (title.trim() && title !== target) return title.trim();
  try {
    const url = new URL(target);
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname.split('/').pop() || url.pathname) : url.host + url.pathname.replace(/\/$/, '');
  } catch {
    return path.basename(target);
  }
}

export function notificationCommand(viewer: App, label: string, notifier: string | undefined): { argv: string[]; kind: 'clickable' | 'plain' } {
  const message = `Page ready in ${viewer.name}: ${label}`;
  if (notifier) {
    return { kind: 'clickable', argv: [notifier, '-title', 'browser show', '-message', message, '-activate', viewer.bundleId, '-group', 'browser-show'] };
  }
  const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
  return { kind: 'plain', argv: ['/usr/bin/osascript', '-e', `display notification ${quote(message)} with title "browser show"`] };
}

function run(argv: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5_000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function seeShown(viewer: App | undefined, inFront: boolean, label: string, whyUnknown?: string): Promise<Seen> {
  if (process.platform !== 'darwin') {
    return { visible: false, frontmost: 'unknown', notification: 'none', unknownWhy: `only macOS reports the app in front, and this is ${process.platform}` };
  }
  let front: App | undefined;
  let frontWhy: string | undefined;
  try {
    front = (await frontmostApp()) ?? undefined;
  } catch (error) {
    frontWhy = `the app in front could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  const visible = isVisible(viewer, inFront, front);
  const seen: Seen = { visible, frontmost: front?.name ?? 'unknown', notification: 'none' };
  const why = viewer ? frontWhy : whyUnknown ?? 'the viewer app is unknown';
  if (why) seen.unknownWhy = why;
  if (visible || !viewer) return seen;
  const command = notificationCommand(viewer, label, findNotifier());
  if (await run(command.argv)) seen.notification = command.kind;
  return seen;
}
