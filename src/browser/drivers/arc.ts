/** Native Apple Events transport. Never uses CDP or launches an Arc process. */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ArcNativeTabRef {
  windowId: string;
  spaceId: string;
  tabId: string;
}
export interface ArcNativeTab extends ArcNativeTabRef { url: string; title: string }
export interface ArcEnumeratedSpace {
  windowId: string;
  spaceId: string;
  spaceTitle: string;
  activeTabId?: string;
  /** The Space this window currently shows; empty when Arc did not say. */
  activeSpaceId?: string;
  tabs: ArcNativeTab[];
}

/** Choose the window and Space a new task opens in: every Arc window lists every Space, so
 * prefer the frontmost window showing a profile Space, else frontmost and the first Space. */
export function pickArcSpace(
  own: ReadonlyArray<{ id: string; title: string }>,
  live: ReadonlyArray<ArcEnumeratedSpace>,
): { windowId: string; spaceId: string; spaceTitle: string } | undefined {
  const ownIds = new Set(own.map((space) => space.id));
  const showing = live.find((row) => row.spaceId === row.activeSpaceId && ownIds.has(row.spaceId));
  if (showing) {
    const space = own.find((candidate) => candidate.id === showing.spaceId)!;
    return { windowId: showing.windowId, spaceId: space.id, spaceTitle: space.title };
  }
  for (const space of own) {
    const row = live.find((candidate) => candidate.spaceId === space.id);
    if (row) return { windowId: row.windowId, spaceId: space.id, spaceTitle: space.title };
  }
  return undefined;
}

/**
 * Where `show` puts a page for the owner: a window that is not one of the agent's
 * first, so a task's window is left alone, then an agent window when no other one
 * is visible. On zion (2026-11-07) the recorded agent window was the owner's only
 * visible Arc window, so excluding it made every `show` fail with "via": "none".
 */
export function pickShowSpace(
  own: ReadonlyArray<{ id: string; title: string }>,
  live: ReadonlyArray<ArcEnumeratedSpace>,
  agentWindows: ReadonlySet<string>,
): { windowId: string; spaceId: string; spaceTitle: string } | undefined {
  return pickArcSpace(own, live.filter((space) => !agentWindows.has(space.windowId))) ?? pickArcSpace(own, live);
}

export class ArcNativeCapabilityError extends Error {
  constructor(public readonly capability: string, message?: string) {
    super(message ?? `Native Arc does not support ${capability}. Use a configured browser with that capability.`);
    this.name = 'ArcNativeCapabilityError';
  }
}

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const APP_ID = 'company.thebrowser.Browser';
let operationQueue: Promise<unknown> = Promise.resolve();

/** Serialize native operations in this service, including failures. */
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

/** AppleScript strings do not implement JSON's \uXXXX escape syntax. */
export function escapeAppleScriptString(value: string): string {
  const parts = value.split(/([\u0000-\u001f])/u).filter(Boolean);
  if (parts.length === 0) return '""';
  return '(' + parts.map(part => part.length === 1 && part.charCodeAt(0) < 32
    ? `(character id ${part.charCodeAt(0)})`
    : `"${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' & ') + ')';
}

/** No shell, bounded output and lifetime, and no blocking of the shared daemon. */
export function execAppleScript(source: string, timeoutMs = TIMEOUT_MS, language: 'AppleScript' | 'JavaScript' = 'AppleScript'): Promise<string> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native Arc requires macOS.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('Invalid Apple Events timeout.'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', language], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const abort = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => abort(new Error(`Arc Apple Event timed out after ${timeoutMs}ms.`)), timeoutMs);
    for (const [stream, target] of [[child.stdout, chunks], [child.stderr, errors]] as const) {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) abort(new Error('Arc Apple Event output exceeded the safety limit.'));
        else target.push(chunk);
      });
    }
    child.stdin.on('error', error => abort(error));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new Error(`Arc Apple Event failed (${signal ?? code}): ${Buffer.concat(errors).toString('utf8').trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(source);
  });
}

// Foundation serializes arbitrary titles/URLs, including tabs, newlines and Unicode.
// Delimiter splitting is not a safe wire format for browser-controlled strings.
const PRELUDE = `use framework "Foundation"
use scripting additions
on jsonString(rawValue)
  if rawValue is missing value then set rawValue to ""
  set wrapped to {current application's NSString's stringWithString:(rawValue as text)}
  set jsonData to current application's NSJSONSerialization's dataWithJSONObject:wrapped options:0 |error|:(missing value)
  set jsonText to (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
  return text 2 thru -2 of jsonText
end jsonString
`;

function script(body: string): string {
  return `${PRELUDE}\nif application id "${APP_ID}" is not running then error "Arc is not running. Open it before starting a native task."
tell application id "${APP_ID}"
${body}
end tell`;
}

function identity(value: string, kind: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error(`Missing or invalid native ${kind} ID.`);
  return escapeAppleScriptString(value);
}

/** Resolve ordinals afresh inside the operation; never persist an index. Each
 * `X of every Y` is one Apple Event: a per-tab repeat blew the 15 s budget. */
function lookup(ref: Pick<ArcNativeTabRef, 'windowId' | 'spaceId'> & { tabId?: string }, missing = 'error "Native Arc target is no longer in its original window and Space."'): string {
  return `set targetWindowIndex to 0
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if (item wi of windowIds as text) is ${identity(ref.windowId, 'window')} and (item wi of windowVisible) then set targetWindowIndex to wi as integer
end repeat
if targetWindowIndex is 0 then
  ${missing}
end if
set targetSpaceIndex to 0
set spaceIds to id of every space of window targetWindowIndex
repeat with si from 1 to count of spaceIds
  if (item si of spaceIds as text) is ${identity(ref.spaceId, 'Space')} then set targetSpaceIndex to si as integer
end repeat
if targetSpaceIndex is 0 then
  ${missing}
end if
set targetSpace to a reference to space targetSpaceIndex of window targetWindowIndex
${ref.tabId === undefined ? '' : `set targetTabIndex to 0
set tabIds to id of every tab of targetSpace
repeat with ti from 1 to count of tabIds
  if (item ti of tabIds as text) is ${identity(ref.tabId, 'tab')} then set targetTabIndex to ti as integer
end repeat
if targetTabIndex is 0 then
  ${missing}
end if
set targetTab to a reference to tab targetTabIndex of targetSpace`}`;
}

// Window and Space ids come from the lists `lookup` captured, never from
// `window targetWindowIndex`: AppleScript re-resolves that by position, and Arc
// reorders `every window` when a tab is made in a window not in front.
const TAB_JSON = `"{\\"windowId\\":" & my jsonString(item targetWindowIndex of windowIds) & ",\\"spaceId\\":" & my jsonString(item targetSpaceIndex of spaceIds) & ",\\"tabId\\":" & my jsonString(id of targetTab) & ",\\"url\\":" & my jsonString(URL of targetTab) & ",\\"title\\":" & my jsonString(title of targetTab) & "}"`;

function parse<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('Arc returned an invalid native response; no target was adopted.'); }
}

export function isArcRunning(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return serialized(async () => (await execAppleScript(`return application id "${APP_ID}" is running`)) === 'true');
}

export function enumerateArcSpaces(): Promise<ArcEnumeratedSpace[]> {
  return serialized(async () => parse(await execAppleScript(script(`set resultText to "["
set separator to ""
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if item wi of windowVisible then
    set targetWindowIndex to wi as integer
    set windowIdText to my jsonString(item wi of windowIds)
    set activeId to ""
    try
      set activeId to id of active tab of window targetWindowIndex as text
    end try
    set activeSpaceId to ""
    try
      set activeSpaceId to id of active space of window targetWindowIndex as text
    end try
    set spaceIds to id of every space of window targetWindowIndex
    set spaceTitles to title of every space of window targetWindowIndex
    repeat with si from 1 to count of spaceIds
      set targetSpace to a reference to space si of window targetWindowIndex
      set resultText to resultText & separator & "{\\"windowId\\":" & windowIdText & ",\\"spaceId\\":" & my jsonString(item si of spaceIds) & ",\\"spaceTitle\\":" & my jsonString(item si of spaceTitles) & ",\\"activeTabId\\":" & my jsonString(activeId) & ",\\"activeSpaceId\\":" & my jsonString(activeSpaceId) & ",\\"tabs\\":["
      set tabIds to id of every tab of targetSpace
      set tabUrls to URL of every tab of targetSpace
      set tabTitles to title of every tab of targetSpace
      set tabSeparator to ""
      repeat with ti from 1 to count of tabIds
        set resultText to resultText & tabSeparator & "{\\"windowId\\":" & windowIdText & ",\\"spaceId\\":" & my jsonString(item si of spaceIds) & ",\\"tabId\\":" & my jsonString(item ti of tabIds) & ",\\"url\\":" & my jsonString(item ti of tabUrls) & ",\\"title\\":" & my jsonString(item ti of tabTitles) & "}"
        set tabSeparator to ","
      end repeat
      set resultText to resultText & "]}"
      set separator to ","
    end repeat
  end if
end repeat
return resultText & "]"`))));
}

/** The AppleScript createArcTab runs; exported so its shape can be tested without Arc. */
export function createArcTabScript(target: Pick<ArcNativeTabRef, 'windowId' | 'spaceId'>, markerUrl: string): string {
  return script(`${lookup(target)}
set existingUrls to URL of every tab of targetSpace
repeat with ti from 1 to count of existingUrls
  if (item ti of existingUrls as text) is ${escapeAppleScriptString(markerUrl)} then error "Creation marker already exists; reconcile the saved intent instead of creating another tab."
end repeat
tell targetSpace
  make new tab with properties {URL:${escapeAppleScriptString(markerUrl)}}
end tell
set matchCount to 0
set targetTabIndex to 0
-- Arc commits the new tab's URL asynchronously: read back immediately it is
-- still empty. Poll briefly (bounded) until the marker shows up.
repeat with attempt from 1 to 30
  -- Making the tab can move its window in the window list; find it again by id.
  ${lookup(target)}
  set matchCount to 0
  set createdUrls to URL of every tab of targetSpace
  repeat with ti from 1 to count of createdUrls
    if (item ti of createdUrls as text) is ${escapeAppleScriptString(markerUrl)} then
      set matchCount to matchCount + 1
      set targetTabIndex to ti as integer
    end if
  end repeat
  if matchCount is not 0 then exit repeat
  delay 0.1
end repeat
if matchCount is not 1 then error "Creation marker did not resolve exactly one tab; preserve the creation intent for recovery."
set targetTab to a reference to tab targetTabIndex of targetSpace
return ${TAB_JSON}`);
}

/** Caller durably records marker intent before calling; never use a real page URL as ownership. */
export function createArcTab(target: Pick<ArcNativeTabRef, 'windowId' | 'spaceId'>, markerUrl: string): Promise<ArcNativeTab> {
  if (!markerUrl || markerUrl.length > 16_384) return Promise.reject(new Error('A bounded unique tab creation marker URL is required.'));
  return serialized(async () => parse(await execAppleScript(createArcTabScript(target, markerUrl))));
}

export function resolveArcTab(ref: ArcNativeTabRef): Promise<ArcNativeTab | null> {
  return serialized(async () => parse(await execAppleScript(script(`${lookup(ref, 'return "null"')}\nreturn ${TAB_JSON}`))));
}

export function navigateArcTab(ref: ArcNativeTabRef, url: string): Promise<void> {
  return serialized(async () => {
    await execAppleScript(script(`${lookup(ref)}\nset URL of targetTab to ${escapeAppleScriptString(url)}\nreturn "navigated"`));
  });
}

/** Arc serializes a returned object once. JSON.stringify at the top level would double-encode. */
export function executeJavaScript(ref: ArcNativeTabRef, expression: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const wrapper = `(()=>{try{const value=(0,eval)(${JSON.stringify(expression)});if(value!=null&&typeof value.then==='function')return {ok:false,error:'Native Arc does not support asynchronous evaluation.'};return {ok:true,hasValue:value!==undefined,value:value===undefined?null:JSON.parse(JSON.stringify(value))}}catch(error){return {ok:false,error:String(error)}}})()`;
  return serialized(async () => {
    const result = parse<{ ok: boolean; hasValue?: boolean; value?: unknown; error?: string }>(await execAppleScript(script(`${lookup(ref)}\nreturn execute targetTab javascript ${escapeAppleScriptString(wrapper)}`), timeoutMs));
    if (!result || result.ok !== true) throw new Error(result?.error ?? 'Native Arc JavaScript returned no result.');
    return result.hasValue ? result.value : undefined;
  });
}

export function closeArcTab(ref: ArcNativeTabRef): Promise<'closed' | 'missing'> {
  return serialized(async () => {
    const result = await execAppleScript(script(`${lookup(ref, 'return "missing"')}\nclose targetTab\nreturn "closed"`));
    if (result !== 'closed' && result !== 'missing') throw new Error('Arc did not confirm tab cleanup.');
    return result;
  });
}

/** Explicit user-facing focus only. Evaluation and cleanup never invoke this. `activate` also brings Arc to the front. */
export function selectArcTab(ref: ArcNativeTabRef, opts: { activate?: boolean } = {}): Promise<void> {
  return serialized(async () => { await execAppleScript(selectArcTabScript(ref, opts)); });
}

/** `activate` brings Arc to the front after selecting; Arc refuses `set index of window` (-10000). */
export function selectArcTabScript(ref: ArcNativeTabRef, opts: { activate?: boolean } = {}): string {
  const raise = opts.activate ? '\nactivate' : '';
  return script(`${lookup(ref)}\nselect targetTab${raise}\nreturn "selected"`);
}

/** AppleScript that selects `tabId` in whatever Space of window `targetWindowIndex` holds it; returns "true"/"false". */
function selectTabInWindowScript(tabId: string): string {
  return `set spaceCount to count of spaces of window targetWindowIndex
repeat with si from 1 to spaceCount
  set candidateIds to id of every tab of space si of window targetWindowIndex
  repeat with ti from 1 to count of candidateIds
    if (item ti of candidateIds as text) is ${identity(tabId, 'tab')} then
      select tab ti of space si of window targetWindowIndex
      return "true"
    end if
  end repeat
end repeat
return "false"`;
}

/** Select `tabId` in window `windowId` (any Space), to return the owner to their
 * tab after a failed creation. Returns false when the tab is gone. */
export function selectWindowTab(windowId: string, tabId: string): Promise<boolean> {
  return serialized(async () => (await execAppleScript(script(`set targetWindowIndex to 0
set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if (item wi of windowIds as text) is ${identity(windowId, 'window')} and (item wi of windowVisible) then set targetWindowIndex to wi as integer
end repeat
if targetWindowIndex is 0 then return "false"
${selectTabInWindowScript(tabId)}`))) === 'true');
}

/** Restore only while the task's new tab is still selected; preserve a later human choice. */
export function restoreArcSelection(owned: ArcNativeTabRef, previousTabId: string): Promise<boolean> {
  return serialized(async () => (await execAppleScript(script(`${lookup(owned, 'return "false"')}
if (id of active tab of window targetWindowIndex as text) is not ${identity(owned.tabId, 'tab')} then return "false"
${selectTabInWindowScript(previousTabId)}`))) === 'true');
}

export interface ArcAgentWindow { windowId: string; cgWindowId: number }

export interface ArcScreenWindow { id: number; onScreen: boolean; x: number; y: number; width: number; height: number; scale: number }

// Window numbers and bounds need no Screen Recording grant; titles would.
const ARC_SCREEN_WINDOWS_JXA = `ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('${APP_ID}').js;
const out = [];
if (apps.length) {
  const pid = apps[0].processIdentifier;
  const screens = $.NSScreen.screens.js;
  const mainHeight = screens[0].frame.size.height;
  const rows = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
  for (let i = 0; i < rows.count; i++) {
    const row = rows.objectAtIndex(i);
    if (row.objectForKey('kCGWindowOwnerPID').js !== pid || row.objectForKey('kCGWindowLayer').js !== 0) continue;
    const b = row.objectForKey('kCGWindowBounds');
    const x = b.objectForKey('X').js, y = b.objectForKey('Y').js;
    const width = b.objectForKey('Width').js, height = b.objectForKey('Height').js;
    const cx = x + width / 2, cy = mainHeight - (y + height / 2);
    const screen = screens.find((s) => { const f = s.frame; return cx >= f.origin.x && cx < f.origin.x + f.size.width && cy >= f.origin.y && cy < f.origin.y + f.size.height; });
    const onScreen = row.objectForKey('kCGWindowIsOnscreen');
    out.push({ id: row.objectForKey('kCGWindowNumber').js, onScreen: onScreen.isNil() ? false : onScreen.js === true, x, y, width, height, scale: screen ? screen.backingScaleFactor : 0 });
  }
}
JSON.stringify(out);`;

async function screenWindows(): Promise<ArcScreenWindow[]> {
  return parse<ArcScreenWindow[]>(await execAppleScript(ARC_SCREEN_WINDOWS_JXA, TIMEOUT_MS, 'JavaScript'));
}

/** Arc keeps a closed window in `every window` with visible false and macOS keeps its number. A minimized
 * window may read the same and be replaced; Arc refuses `set minimized`, so that was not observed. */
export function isArcAgentWindowLive(window: ArcAgentWindow): Promise<boolean> {
  return serialized(async () => {
    const visible = await execAppleScript(script(`set windowIds to id of every window
set windowVisible to visible of every window
repeat with wi from 1 to count of windowIds
  if (item wi of windowIds as text) is ${identity(window.windowId, 'window')} then return (item wi of windowVisible) as text
end repeat
return "false"`));
    return visible === 'true' && (await screenWindows()).some((row) => row.id === window.cgWindowId);
  });
}

/** `make new window` leaves the frontmost app in front; AppleScript and CoreGraphics share no window id. */
export function openArcAgentWindow(): Promise<ArcAgentWindow> {
  return serialized(async () => {
    const before = new Set((await screenWindows()).map((row) => row.id));
    const windowId = await execAppleScript(script(`set beforeIds to id of every window
make new window
repeat 50 times
  set afterIds to id of every window
  repeat with candidate in afterIds
    if beforeIds does not contain (candidate as text) then return (candidate as text)
  end repeat
  delay 0.1
end repeat
error "Arc did not report the window it opened."`));
    for (let attempt = 0; attempt < 30; attempt++) {
      const added = (await screenWindows()).filter((row) => row.onScreen && !before.has(row.id));
      if (added.length === 1) return { windowId, cgWindowId: added[0].id };
      if (added.length > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Arc opened window ${windowId}, but macOS did not show exactly one new Arc window for it.`);
  });
}

/** Arc 1.x, 2026-10-27: a 2304x1204 window put its 2048x1152 page at x 246-2293, y 42-1193. */
export const ARC_PAGE_INSET_POINTS = 10;

export function arcPageRect(geometry: {
  imageWidth: number; imageHeight: number; windowWidth: number; windowHeight: number;
  innerWidth: number; innerHeight: number; devicePixelRatio: number; backingScale: number;
  sidebarWidth: number;
}): { x: number; y: number; width: number; height: number } {
  const { imageWidth, imageHeight, windowWidth, innerWidth, innerHeight, devicePixelRatio, backingScale } = geometry;
  const values = Object.values(geometry);
  if (!values.every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Arc did not report the page and window geometry a screenshot needs.');
  }
  const pixelsPerPoint = imageWidth / windowWidth;
  if (Math.abs(imageHeight / geometry.windowHeight - pixelsPerPoint) > pixelsPerPoint * 0.01) {
    throw new Error(`The window capture (${imageWidth}x${imageHeight}) is not the shape of the agent's Arc window; nothing was saved.`);
  }
  const zoom = devicePixelRatio / backingScale;
  const width = Math.round(innerWidth * zoom * pixelsPerPoint);
  const height = Math.round(innerHeight * zoom * pixelsPerPoint);
  const inset = Math.round(ARC_PAGE_INSET_POINTS * pixelsPerPoint);
  const rect = { x: imageWidth - inset - width, y: imageHeight - inset - height, width, height };
  if (rect.x < Math.round(geometry.sidebarWidth * pixelsPerPoint) || rect.y < 0) {
    throw new Error(
      `The page (${width}x${height}) would overlap Arc's sidebar in the window capture (${imageWidth}x${imageHeight}); nothing was saved.`,
    );
  }
  return rect;
}

/** An unwritten window takes the app preference. Only an anchored (left) sidebar is captured around, never a hidden one. */
export function readArcSidebar(windowId: string, file = path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableWindows.json')): { width: number } {
  let state: { sidebarViewPreferences?: { sidebarWidth?: unknown; sidebarMode?: unknown }; windows?: Array<{ id?: unknown; sidebarWidth?: unknown; sidebarMode?: unknown }> };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Cannot read Arc\'s window layout (StorableWindows.json); nothing was captured.');
  }
  const own = state.windows?.find((row) => row.id === windowId) ?? state.sidebarViewPreferences;
  if (own?.sidebarMode !== 'anchored') {
    throw new Error('The agent\'s Arc window does not show its sidebar anchored, so the page edge is unknown; nothing was captured. Show the sidebar in that window.');
  }
  if (typeof own.sidebarWidth !== 'number' || !(own.sidebarWidth > 0)) {
    throw new Error('Arc did not record the agent window\'s sidebar width; nothing was captured.');
  }
  return { width: own.sidebarWidth };
}

export function selectForCaptureScript(ref: ArcNativeTabRef): string {
  return script(`${lookup(ref)}
set activeIds to {}
repeat with wi from 1 to count of windowIds
  if wi is not targetWindowIndex then
    try
      set end of activeIds to (id of active tab of window wi) as text
    end try
  end if
end repeat
if activeIds contains (${identity(ref.tabId, 'tab')}) then error "Another Arc window is showing this tab; it was not captured."
if (id of active tab of window targetWindowIndex as text) is not ${identity(ref.tabId, 'tab')} then select targetTab
repeat 20 times
  if (id of active tab of window targetWindowIndex as text) is ${identity(ref.tabId, 'tab')} then exit repeat
  delay 0.1
end repeat
if (id of active tab of window targetWindowIndex as text) is not ${identity(ref.tabId, 'tab')} then error "Arc did not select the task's tab in its window; it was not captured."
return "{\\"title\\":" & my jsonString(title of targetTab) & ",\\"geometry\\":" & (execute targetTab javascript "[innerWidth, innerHeight, devicePixelRatio]") & "}"`);
}

function cropScript(source: string, target: string, rect: { x: number; y: number; width: number; height: number }, format: 'png' | 'jpeg', quality: number): string {
  return `ObjC.import('AppKit');
const rep = $.NSBitmapImageRep.imageRepWithData($.NSData.dataWithContentsOfFile(${JSON.stringify(source)}));
if (!rep || rep.isNil()) throw new Error('The window capture could not be read.');
const cropped = $.CGImageCreateWithImageInRect(rep.CGImage, $.CGRectMake(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height}));
const out = $.NSBitmapImageRep.alloc.initWithCGImage(cropped);
const data = out.representationUsingTypeProperties(${format === 'png' ? '$.NSBitmapImageFileTypePNG' : '$.NSBitmapImageFileTypeJPEG'}, $({ NSImageCompressionFactor: ${quality} }));
if (!data.writeToFileAtomically(${JSON.stringify(target)}, true)) throw new Error('The cropped screenshot could not be written.');
'ok';`;
}

// A service started over ssh can have a PATH without the npm global bin.
const COMPUTER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

function computerBinary(): string {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...COMPUTER_DIRS];
  for (const dir of dirs) {
    const candidate = path.join(dir, 'computer');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { continue; }
  }
  throw new Error(
    'Arc screenshots capture the agent\'s Arc window through the Computer helper, which holds the macOS Screen Recording grant. ' +
      `No \`computer\` command was found in ${dirs.join(':')}. Install it with \`npm install -g @phnx-labs/computer-cli\`, then run \`computer setup\`.`,
  );
}

function runComputer(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(computerBinary(), args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error?.killed) {
        reject(new Error(`ScreenCaptureKit timed out: the Computer helper did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      } else if (error) {
        reject(new Error(`Capturing the agent's Arc window failed (computer exited ${error.code ?? 'abnormally'}). Run \`computer setup\` to check the Screen Recording permission.`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export function captureArcTab(
  ref: ArcNativeTabRef,
  window: ArcAgentWindow,
  opts: { format: 'png' | 'jpeg'; qualities?: number[]; maxBytes?: number },
): Promise<Buffer> {
  if (ref.windowId !== window.windowId) {
    return Promise.reject(new Error('Only a tab in the agent\'s Arc window is captured.'));
  }
  return serialized(async () => {
    const page = parse<{ title: string; geometry: [number, number, number] }>(await execAppleScript(selectForCaptureScript(ref)));
    const sidebar = readArcSidebar(window.windowId);
    const screen = (await screenWindows()).find((row) => row.id === window.cgWindowId);
    if (!screen?.onScreen) throw new Error('The agent\'s Arc window is not on screen (minimized, hidden or on another desktop).');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-arc-'));
    try {
      const raw = path.join(dir, 'window.jpg');
      const args = ['screenshot', '--bundle', APP_ID, '--window-id', String(window.cgWindowId), '--quality', '100', '--out', raw, '--json'];
      // A frame painted before the switch carries the old title, and ScreenCaptureKit took 1-7 s and
      // sometimes timed out (2026-10-27), so a mismatch or a timeout is retried: three captures in 40 s.
      type Capture = { window_id: number; title?: string; width: number; height: number };
      let meta: Capture | undefined;
      let reason = '';
      const deadline = Date.now() + 40_000;
      for (let attempt = 0; attempt < 3 && !meta && Date.now() < deadline - 1_000; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
        let captured: Capture;
        try {
          captured = parse<Capture>(await runComputer(args, Math.min(20_000, deadline - Date.now())));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('ScreenCaptureKit timed out')) throw error;
          reason = error.message;
          continue;
        }
        if (captured.window_id !== window.cgWindowId) throw new Error('The Computer helper captured a different window; it was discarded.');
        if (captured.title === page.title) meta = captured;
        else reason = 'The agent\'s Arc window did not show the task\'s tab when it was captured; the image was discarded. Retry.';
      }
      if (!meta) throw new Error(reason || 'The agent\'s Arc window could not be captured within 40 s.');
      const after = await execAppleScript(script(`${lookup(ref)}\nreturn id of active tab of window targetWindowIndex as text`));
      if (after !== ref.tabId) throw new Error('The agent\'s Arc window changed tabs during the capture; it was discarded. Retry.');
      const rect = arcPageRect({
        imageWidth: meta.width, imageHeight: meta.height, windowWidth: screen.width, windowHeight: screen.height,
        innerWidth: page.geometry[0], innerHeight: page.geometry[1], devicePixelRatio: page.geometry[2], backingScale: screen.scale,
        sidebarWidth: sidebar.width,
      });
      const target = path.join(dir, opts.format === 'png' ? 'page.png' : 'page.jpg');
      let buffer: Buffer = Buffer.alloc(0);
      for (const quality of opts.qualities ?? [1]) {
        await execAppleScript(cropScript(raw, target, rect, opts.format, quality), TIMEOUT_MS, 'JavaScript');
        buffer = await fs.promises.readFile(target);
        if (opts.maxBytes === undefined || buffer.length <= opts.maxBytes) break;
      }
      return buffer;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
}
