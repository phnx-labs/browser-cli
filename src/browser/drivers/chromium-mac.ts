// CDP's Target.activateTarget raises the window; the app's own AppleScript selects a tab without.
import { execAppleScript } from './arc.js';

export interface ChromiumWindow { id: string; minimized: boolean; activeTabIndex: number; urls: string[] }
export interface ChromiumApp { name: string; bundleId: string; windows: ChromiumWindow[] }

const ensureNumber = (value: number) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid process or tab number ${value}.`);
  return value;
};

function readScript(pid: number): string {
  return `const procs = Application('System Events').applicationProcesses.whose({ unixId: ${ensureNumber(pid)} })();
if (procs.length === 0) { 'null' } else {
  const bundleId = procs[0].bundleIdentifier();
  const app = Application(bundleId);
  JSON.stringify({ name: procs[0].name(), bundleId, windows: app.windows().map((w) => ({
    id: String(w.id()), minimized: w.minimized(), activeTabIndex: w.activeTabIndex(), urls: w.tabs.url(),
  })) });
}`;
}

export function selectChromiumTabScript(bundleId: string, windowId: string, index: number): string {
  return `const app = Application(${JSON.stringify(bundleId)});
const win = app.windows().find((w) => String(w.id()) === ${JSON.stringify(windowId)});
if (win) win.activeTabIndex = ${ensureNumber(index)};
String(Boolean(win));`;
}

export function pickChromiumTab(
  windows: ReadonlyArray<ChromiumWindow>,
  shows: (url: string) => boolean,
  preferWindowId?: string,
  newest = false,
): { windowId: string; index: number } | undefined {
  const ordered = [...windows].sort((a, b) => Number(b.id === preferWindowId) - Number(a.id === preferWindowId));
  for (const win of ordered) {
    const hits = win.urls.flatMap((url, i) => (shows(url) ? [i] : []));
    const at = hits.length === 0 ? -1 : newest ? hits[hits.length - 1]! : hits[0]!;
    if (at >= 0) return { windowId: win.id, index: at + 1 };
  }
  return undefined;
}

export function chromiumSelection(windows: ReadonlyArray<ChromiumWindow>, picked: { windowId: string; index: number }) {
  const win = windows.find((w) => w.id === picked.windowId);
  const front = windows.find((w) => !w.minimized);
  return { selected: win?.activeTabIndex === picked.index, frontWindow: front !== undefined && front.id === picked.windowId };
}

async function readApp(pid: number): Promise<ChromiumApp | null> {
  return JSON.parse(await execAppleScript(readScript(pid), undefined, 'JavaScript')) as ChromiumApp | null;
}

export async function selectChromiumTab(
  pid: number,
  shows: (url: string) => boolean,
  preferWindowId?: string,
  newest = false,
): Promise<{ app: { name: string; bundleId: string }; selected: boolean; frontWindow: boolean } | undefined> {
  const before = await readApp(pid);
  if (!before) return undefined;
  const app = { name: before.name, bundleId: before.bundleId };
  const picked = pickChromiumTab(before.windows, shows, preferWindowId, newest);
  if (!picked) return { app, selected: false, frontWindow: false };
  await execAppleScript(selectChromiumTabScript(before.bundleId, picked.windowId, picked.index), undefined, 'JavaScript');
  const after = await readApp(pid);
  return { app, ...chromiumSelection(after?.windows ?? [], picked) };
}
