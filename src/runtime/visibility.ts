import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface App { name: string; bundleId: string }

export interface Seen {
  /** Only when observed: the tab selected in its app's front window (`window 1`; its desktop Space is unreadable), that app in front. */
  visible: boolean;
  frontmost: string;
  notification: 'clickable' | 'plain' | 'none';
  unknownWhy?: string;
  hiddenSpace?: string;
  hiddenWhy?: string;
}

export interface TabSeen { inFront: boolean; whyUnknown?: string; hiddenSpace?: string }

export const OS_HANDLER_BLIND = 'the OS default handler opened it and cannot be asked which tab or window is showing';

export function osHandlerTab(viewer: App | undefined): TabSeen {
  return { inFront: false, whyUnknown: viewer ? OS_HANDLER_BLIND : 'macOS named no app that opens it' };
}

export function judgeShown(viewer: App | undefined, tab: TabSeen, front: App | undefined, frontWhy?: string): Omit<Seen, 'notification'> {
  const visible = viewer !== undefined && front !== undefined && tab.inFront && front.bundleId === viewer.bundleId;
  const why = frontWhy ?? tab.whyUnknown ?? (viewer ? undefined : 'the viewer app is unknown');
  const hidden = tab.hiddenSpace && viewer && !visible
    ? { hiddenSpace: tab.hiddenSpace, hiddenWhy: `the tab is in ${viewer.name} Space ${tab.hiddenSpace}, which is not the one showing` }
    : {};
  return { visible, frontmost: front?.name ?? 'unknown', ...(why && !visible ? { unknownWhy: why } : {}), ...hidden };
}

export const FRONTMOST_JXA = `const front = Application('System Events').applicationProcesses.whose({ frontmost: true })();
front.length === 0 ? 'null' : JSON.stringify({ name: front[0].name(), bundleId: front[0].bundleIdentifier() });`;

async function frontmostApp(): Promise<App | null> {
  const { execAppleScript } = await import('../browser/drivers/arc.js');
  return JSON.parse(await execAppleScript(FRONTMOST_JXA, 5_000, 'JavaScript')) as App | null;
}

export function handlerScript(target: string): string {
  const url = path.isAbsolute(target) ? `$.NSURL.fileURLWithPath(${JSON.stringify(target)})` : `$.NSURL.URLWithString(${JSON.stringify(target)})`;
  return `ObjC.import('AppKit');
const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(${url});
if (app.isNil()) { 'null' } else {
  const bundle = $.NSBundle.bundleWithURL(app);
  JSON.stringify({ name: ObjC.unwrap(app.lastPathComponent).replace(/\\.app$/, ''), bundleId: ObjC.unwrap(bundle.bundleIdentifier) });
}`;
}

export async function handlerApp(target: string): Promise<App | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const { execAppleScript } = await import('../browser/drivers/arc.js');
  const raw = await execAppleScript(handlerScript(target), 5_000, 'JavaScript').catch(() => 'null');
  return (JSON.parse(raw) as App | null) ?? undefined;
}

export function launchedScript(bundleId: string): string {
  return `ObjC.import('AppKit');
const apps = ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)}));
String(apps.some((app) => app.finishedLaunching));`;
}

const LAUNCH_WAIT_MS = 5_000;

export async function untilLaunched(viewer: App): Promise<string | undefined> {
  const { execAppleScript } = await import('../browser/drivers/arc.js');
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  for (;;) {
    try {
      if ((await execAppleScript(launchedScript(viewer.bundleId), 2_000, 'JavaScript')).trim() === 'true') return undefined;
    } catch (error) {
      return `whether ${viewer.name} has launched could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (Date.now() >= deadline) return `${viewer.name} had not finished launching after ${LAUNCH_WAIT_MS / 1000} s`;
    await new Promise((r) => setTimeout(r, 250));
  }
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

export async function seeShown(viewer: App | undefined, tab: TabSeen, label: string, frontUnsettled?: string): Promise<Seen> {
  if (process.platform !== 'darwin') {
    return { visible: false, frontmost: 'unknown', notification: 'none', unknownWhy: `only macOS reports the app in front, and this is ${process.platform}` };
  }
  let front: App | undefined;
  let frontWhy = frontUnsettled;
  if (!frontWhy) {
    try {
      front = (await frontmostApp()) ?? undefined;
    } catch (error) {
      frontWhy = `the app in front could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const seen: Seen = { ...judgeShown(viewer, tab, front, frontWhy), notification: 'none' };
  if (seen.visible || !viewer) return seen;
  const command = notificationCommand(viewer, label, findNotifier());
  if (await run(command.argv)) seen.notification = command.kind;
  return seen;
}
