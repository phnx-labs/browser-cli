import { listTaskArtifacts, countByKind } from './sessions-list.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BrowserCdpConnectionError,
  CDPClient,
  discoverBrowserWsUrl,
  verifyBrowserIdentity,
} from './cdp.js';
import {
  getProfile,
  getProfileRuntimeDir,
  getProfileDownloadsDir,
  getProfileSessionsDir,
  getBrowserRuntimeDir,
  listProfiles,
  extractConfiguredPort,
  resolveEndpoint,
  parseEndpointUrl,
} from './profiles.js';
import { killChrome, getRunningChromeInfo, launchBrowser, allocatePort } from './chrome.js';
import { assertBrowserHomeReady, getBrowserServiceDir } from '../runtime/state.js';
import { assertRemoteControlAllowedForRequest } from './remote-control.js';
import { connectLocal } from './drivers/local.js';
import { connectSSH } from './drivers/ssh.js';
import {
  adoptLegacyRuntimeIfLocal,
  isLegacyEndpointKey,
  peerProfileError,
  resolveBrowserTarget,
  shouldForkProfile,
  type DeviceProbe,
} from './resolve-target.js';
import { adoptProfileRuntimeOwner, clearProfileRuntime, listProfileCacheDirs, readProfileRuntimeMeta, isProcessAlive } from './runtime-state.js';
import {
  generateTaskId,
  generateShortId,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileTabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
  type BrowserType,
  type HistoricalTask,
  type ReapResult,
  type ProfileName,
  type ConnectionKey,
  asConnectionKey,
  parseConnectionKey,
  keyBelongsToProfile,
} from './types.js';
import {
  reapAbandonedTasks,
  resolveLiveIdentities,
  taskOwnerIsGone,
  type ReapOptions,
} from './hygiene.js';
import { taskMatchesCaller } from './caller-identity.js';
import { pageText } from './frames.js';
import { getRefs, resolveRefToCoords, describeRefs, healRef, type RefOpts, type RefNode, type RefSnapshot, refStillMatches } from './refs.js';
import { clickAtCoords, coverAt, armClickProbe, clickInDom, hoverAtCoords, scrollAtCoords, typeText, pressKey, focusNode, typeIntoValueInput, chooseNativeOption, nodeOrigin } from './input.js';
import { assertSecretSite } from './secret-ref.js';
import { typeEditorText } from './editor.js';
import {
  arcClickExpression,
  arcFillExpression,
  arcRefsExpression,
  arcScrollExpression,
  arcSelectExpression,
  parseArcRefsResult,
  SELECT_OPTION_FN,
} from './arc-dom.js';
import {
  detectUploadPattern,
  stageUploadFile,
  uploadToDropTarget,
  uploadToFileInput,
  uploadViaFileChooser,
} from './upload.js';
import { emit } from '../runtime/events.js';
import { resolveActor } from '../runtime/actor.js';
import { recordBrowserSession } from '../runtime/session-store.js';
import type {
  TargetFilter,
  PageOpenResult,
  ArcNativeProfileIdentity,
  ArcNativeTabRef,
  FirefoxProfileIdentity,
  PageSnapshot,
} from './types.js';
import { resolveFfmpeg } from './ffmpeg.js';
import {
  FirefoxCapabilityError,
  FirefoxBiDiClient,
  connectFirefox,
  bidiTopLevelContexts,
  bidiCreateTab,
  bidiNavigate,
  bidiReload,
  bidiCloseTab,
  bidiActivate,
  bidiEvaluate,
  bidiScreenshot,
  bidiClickAt,
} from './drivers/firefox.js';
import {
  ArcNativeCapabilityError,
  captureArcTab,
  isArcAgentWindowLive,
  openArcAgentWindow,
  type ArcAgentWindow,
  executeJavaScript,
  navigateArcTab,
  closeArcTab,
  createArcTab,
  enumerateArcSpaces,
  pickArcSpace,
  pickShowSpace,
  isArcRunning,
  type ArcEnumeratedSpace,
  resolveArcTab,
  restoreArcSelection,
  selectWindowTab,
  selectArcTab,
} from './drivers/arc.js';
import { discoverArcProfiles } from './arc-discovery.js';

export type UploadMode = 'auto' | 'input' | 'drop' | 'chooser';

/** Canonicalize URLs to match browser-reported forms, including bare-origin slashes; preserve
 * unparseable input. */
function canonicalTabUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/**
 * Whether two URLs show the same page to a reader: canonical form, ignoring the
 * `#fragment` and a trailing slash on the path. `show` reuses a tab on this match.
 */
export function sameShownPage(a: string, b: string): boolean {
  const key = (raw: string): string => {
    try {
      const parsed = new URL(raw);
      parsed.hash = '';
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
      return parsed.href;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}

const ARC_SHOW_CONFIRM_MS = 5_000;

/** Arc accepts `set URL` and can still leave the tab where it was, and commits asynchronously. */
async function confirmArcShows(ref: ArcNativeTabRef, url: string, before: string): Promise<void> {
  const deadline = Date.now() + ARC_SHOW_CONFIRM_MS;
  for (;;) {
    const tab = await resolveArcTab(ref);
    if (!tab) throw new Error(`Arc closed the tab before it showed ${url}.`);
    if (sameShownPage(tab.url, url) || (tab.url && tab.url !== before)) return;
    if (Date.now() >= deadline) throw new Error(`Arc did not show ${url}: its tab still reports ${tab.url || 'no page'} after ${ARC_SHOW_CONFIRM_MS / 1000} s.`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Navigating `from` to `to` only moves the fragment, which loads nothing, so the page needs a reload too. */
function onlyFragmentMoves(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    if (!b.hash) return false;
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveScreenshotOutputPath(outputPath: string | undefined, automaticPath: string): string {
  if (!outputPath) return automaticPath;

  const runtimeDir = getBrowserRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeReal = fs.realpathSync(runtimeDir);
  const requested = path.resolve(outputPath);
  const parent = path.dirname(requested);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  const resolved = path.join(parentReal, path.basename(requested));
  if (!isPathInside(resolved, runtimeReal)) {
    return automaticPath;
  }
  return resolved;
}

/** Read JPEG pixel dimensions from SOF markers; return null for missing SOI or SOF. */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes) + IHDR chunk: length (4) + 'IHDR' (4) + width (4) + height (4)
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // SOF0–SOFn carry dimensions, except DHT (0xC4), JPG (0xC8), DAC (0xCC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** Parse url:/title: substring filters, or return null; matching ignores metadata capitalization. */
export function parseTargetFilter(filter: string | undefined): TargetFilter | null {
  if (!filter) return null;
  const idx = filter.indexOf(':');
  if (idx <= 0) return null;
  const kind = filter.slice(0, idx).trim().toLowerCase();
  // Strip whitespace around the value so `url: https://x` (with a copy-pasted
  // space after the colon) doesn't silently fail to match — `.includes(' x')`
  // never hits a URL because URLs don't contain spaces.
  const value = filter.slice(idx + 1).trim();
  if (kind !== 'url' && kind !== 'title') return null;
  if (!value) return null;
  return { kind, value };
}

/** Skip housekeeping page targets that would produce blank screenshots unless explicitly selected. */
const INVISIBLE_URL_PATTERNS: RegExp[] = [
  /^about:blank$/i,
  /^file:\/\//i,
  /\/_desktop-background-service(\?|$|\/)/i,
  /\/_internal(\?|$|\/)/i,
  /\/_background(\?|$|\/)/i,
];

function isLikelyInvisible(url: string | undefined): boolean {
  if (!url) return true;
  return INVISIBLE_URL_PATTERNS.some((re) => re.test(url));
}

/** Prefer visible targets within filter matches; an unmatched explicit filter returns undefined. */
export function pickWindowTarget<T extends { type: string; url?: string; title?: string }>(
  targets: T[],
  filter: string | undefined
): T | undefined {
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;

  const parsed = parseTargetFilter(filter);
  if (parsed) {
    const needle = parsed.value.toLowerCase();
    const matches = pages.filter((t) => {
      const hay = (parsed.kind === 'url' ? t.url : t.title) ?? '';
      return hay.toLowerCase().includes(needle);
    });
    if (matches.length === 0) return undefined;
    const visible = matches.find((t) => !isLikelyInvisible(t.url));
    return visible ?? matches[0];
  }

  const visible = pages.find((t) => !isLikelyInvisible(t.url));
  if (visible) return visible;

  return pages[0];
}

/** Probe before reuse because closed browser sockets can remain cached; bound the round trip to one
 * second. */
async function isConnHealthy(conn: ProfileConnection, timeoutMs = 1000): Promise<boolean> {
  // Native Arc connections: healthy if Arc is still running (no CDP socket to probe).
  if (conn.backend === 'arc-native') {
    return isArcRunning();
  }
  // Firefox BiDi connections: healthy while the WebSocket is open (a killed
  // Firefox closes it). No lightweight round-trip verb is needed.
  if (conn.backend === 'bidi') {
    return conn.bidi.isOpen;
  }
  if (!conn.cdp.isOpen) return false;
  try {
    await Promise.race([
      conn.cdp.send('Browser.getVersion'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('healthcheck timeout')), timeoutMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

interface BaseProfileConnection {
  port: number;
  pid: number;
  electron?: boolean;
  /** Arc honors navigation but crashes on Target.createTarget; tab-creating paths must reuse or refuse. */
  browserType?: BrowserType;
  /** Raw `url:<v>` / `title:<v>` filter copied from the profile config. */
  targetFilter?: string;
  /** Connection and runtime-directory key, including endpoint and optional Electron fork suffix. */
  key?: ConnectionKey;
  /** The bare, user-facing profile name this connection belongs to. */
  profile?: ProfileName;
  forkedFrom?: ConnectionKey;
  tasks: Map<string, Task>;
  windowId?: string; // single window shared by all tasks
  targetCache?: { targets: TargetInfo[]; ts: number };
  sessionCache: Map<string, string>;
  /** Run teardown whenever removing the connection so leaked SSH tunnels cannot claim future local
   * ports. */
  cleanup?: () => void;
  /** Check the transport before sending CDP commands; an absent backend means CDP. */
}

interface CdpProfileConnection extends BaseProfileConnection {
  /** Omitted only by legacy/in-process callers; absence means the CDP path. */
  backend?: 'cdp';
  cdp: CDPClient;
}

interface ArcProfileConnection extends BaseProfileConnection {
  backend: 'arc-native';
  browserType: 'arc';
  arcProfile: ArcNativeProfileIdentity;
}

/** Firefox uses WebDriver BiDi; task tab ids are browsing-context ids, with no CDP socket. */
interface FirefoxProfileConnection extends BaseProfileConnection {
  backend: 'bidi';
  browserType: 'firefox';
  bidi: FirefoxBiDiClient;
  firefoxProfile: FirefoxProfileIdentity;
  /** The BiDi session id from `session.new`. */
  sessionId: string;
  /** Absolute Firefox profile directory this connection is bound to. */
  profileDir: string;
}

type ProfileConnection = CdpProfileConnection | ArcProfileConnection | FirefoxProfileConnection;

/** Uploads cannot resolve cross-site iframe refs in the page's session; refuse them to avoid targeting
 * another document. */
function refuseCrossSiteUpload(node: RefNode, ref: number): void {
  if (node.sessionId) {
    throw new Error(
      actionable(
        `Ref ${ref} is inside a cross-site iframe (${node.frame ?? 'unknown'}); upload cannot reach it yet.`,
        `Next: browser navigate ${node.frame ?? '<iframe url>'} and upload there`,
      ),
    );
  }
}

/** Narrow to CDP or throw the backend capability error. */
function requireCdp(
  conn: ProfileConnection,
  capability: string,
): asserts conn is CdpProfileConnection {
  if (conn.backend === 'arc-native') throw new ArcNativeCapabilityError(capability);
  if (conn.backend === 'bidi') throw new FirefoxCapabilityError(capability);
}

/** Join error lines so callers get a next command, not a dead-end message. */
export function actionable(...lines: string[]): string {
  return lines.filter((l) => l != null && l !== '').join('\n');
}


/** Arc crashes on Target.createTarget; refuse creation and direct callers to existing tabs or another
 * browser. */
export function arcNotDrivableError(profileName?: string): Error {
  const scope = profileName ? ` (profile "${profileName}")` : '';
  return new Error(
    actionable(
      `Browser "arc"${scope} cannot open a NEW tab: Arc crashes when a tab is created`,
      'over CDP (Target.createTarget). browser drives Arc by attaching to your',
      'running window and reusing an EXISTING tab — bind the profile to the tab/Space you',
      'want with --target-filter (url:<substring> or title:<substring>), or navigate to a',
      'URL that is already open. To open brand-new tabs, use a Chromium-family browser:',
      '  browser profiles create <name> --browser comet',
    ),
  );
}

/** Derive a human label from an explicit title or a navigated URL. */
export function deriveTaskLabel(opts: { title?: string; url?: string; existing?: string }): string {
  if (opts.title?.trim()) return opts.title.trim();
  if (opts.existing && opts.existing !== 'untitled') return opts.existing;
  if (opts.url) {
    try {
      const host = new URL(opts.url).hostname.replace(/^www\./, '');
      if (host) return host;
    } catch {
      /* unparseable */
    }
  }
  return opts.existing ?? 'untitled';
}

type TargetInfo = {
  targetId: string;
  url?: string;
  title?: string;
};

/** Describes a ref that was re-resolved from a drifted integer via its cached descriptor. */
export interface HealInfo {
  from: number;
  to: number;
  role: string;
  name: string;
  /** Same element, new label: what it reads now (`name` is what the listing showed). */
  renamed?: string;
}

/** Use forwarded caller identity: the shared daemon's actor cannot identify the requesting run. */
export function resolveTaskIdentity(
  forwarded: { actor?: string; launchId?: string; sessionId?: string },
  resolveLocalActor: () => string
): { owner: string; launchId?: string; sessionId?: string } {
  return {
    owner: forwarded.actor ?? resolveLocalActor(),
    launchId: forwarded.launchId,
    sessionId: forwarded.sessionId,
  };
}

export interface StartOptions {
  taskName?: string;
  url?: string;
  endpointName?: string;
  /** Always open a new tab, skipping the abandoned-task reclaim. */
  fresh?: boolean;
  /** Caller identity, forwarded from the CLI (see IPCRequest.actor/launchId). */
  actor?: string;
  launchId?: string;
  /** Calling agent session, forwarded from the CLI (see IPCRequest.sessionId). */
  sessionId?: string;
  /** Whether the CALLER was dispatched here by a fleet `--device` hop. */
  fleetRemote?: boolean;
  /** Explicit human label (`--title`). */
  title?: string;
  /** Injected reachability probe — production uses ssh; tests pass a fake. */
  probe?: DeviceProbe;
}

/** Actions wait for the page to settle unless `wait` is false (`--no-wait`); `snapshot` then lists it. */
export interface ActionOpts {
  snapshot?: boolean;
  wait?: boolean;
}

/** Lifecycle subscription armed before an action; see BrowserService.armSettle. */
interface SettleHandle {
  waitForLoad(loaderId?: string): Promise<void>;
  waitForActionToSettle(): Promise<void>;
  dispose(): void;
}

export interface StartResult {
  task: string;
  name: string;
  tabId?: string;
  windowId?: string;
  /** BARE profile name — what the caller asked for, never the runtime key. */
  profile: ProfileName;
  /** Runtime key the task actually landed on (`<profile>@<device>`). */
  key: ConnectionKey;
  /** Device the daemon connected to. */
  device: string;
  /** A same-name start that matched an existing task and reused it. */
  reused?: boolean;
  /** Record actual page creation/refresh; adopted tabs and no-op reuse are neither. */
  firstOpen?: PageOpenResult;
}

/** Arc accepts only HTTP(S) creation URLs; a unique .invalid URL keeps a matchable marker without a
 * real destination. */
const ARC_CREATE_MARKER_PREFIX = 'https://agents-browser.invalid/';
export function arcCreateMarker(): string {
  return `${ARC_CREATE_MARKER_PREFIX}${crypto.randomUUID()}`;
}
export function isArcCreateMarker(url: string): boolean {
  return url.startsWith(ARC_CREATE_MARKER_PREFIX);
}

/** One shared read of Arc's live state per `status` pass. Both are lazy, so a
 * fleet with no Arc profile never contacts Arc at all. */
interface ArcStatusReaders {
  spaces: () => Promise<ArcEnumeratedSpace[]>;
  running: () => Promise<boolean>;
}

/** Run `fn` once per pass and share its promise, rejections included. */
function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= fn());
}

/**
 * `browser text` is read with grep: a no-break space ("Population\u00a0(2022
 * census)" on Wikipedia) printed as a space but never matched one.
 */
function plainSpaces(text: string): string {
  return text.replace(/[\u00a0\u2007\u202f]/g, ' ');
}

async function evaluateInPage<T>(cdp: CDPClient, params: Record<string, unknown>, sessionId: string): Promise<T> {
  try {
    return await cdp.send<T>('Runtime.evaluate', params, sessionId);
  } catch (error) {
    if (!/Cannot find default execution context/.test(String(error))) throw error;
    await new Promise((r) => setTimeout(r, 500));
    return cdp.send<T>('Runtime.evaluate', params, sessionId);
  }
}

/** Rendered GitHub-style `include-fragment`s still waiting to load, the first scrolled into view; the scroll before it. */
const LAZY_PARTS = `(() => {
  const s = window[Symbol.for('browser-cli lazy parts')] ??= { failed: new WeakSet(), watched: new WeakSet(), scrolled: new Map() };
  const pending = [...document.querySelectorAll('include-fragment[src]')]
    .filter((f) => !s.failed.has(f) && f.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
  const f = pending[0];
  if (!f) return 0;
  if (!s.watched.has(f)) f.addEventListener('error', () => s.failed.add(f), { once: true });
  s.watched.add(f);
  for (let n = f.parentElement; n; n = n.parentElement) if (!s.scrolled.has(n)) s.scrolled.set(n, [n.scrollLeft, n.scrollTop]);
  f.scrollIntoView({ block: 'center', behavior: 'instant' });
  return pending.length;
})()`;
const LAZY_RESTORE = `(() => {
  const key = Symbol.for('browser-cli lazy parts');
  for (const [n, [left, top]] of window[key]?.scrolled ?? []) n.scrollTo({ left, top, behavior: 'instant' });
  delete window[key];
})()`;

/** `type` and `select` by name look only at elements that take text, or choose an option. */
const TYPE_ROLES = ['textbox', 'searchbox', 'combobox', 'spinbutton', 'inputtime', 'date'];
const SELECT_ROLES = ['combobox', 'listbox'];
const NAMED_TARGET_NEEDS_CDP = 'Naming the element needs a Chrome-family browser; pass its ref from `browser refs`.';

/** The identity an unnamed start reuses a task by: the session, else the launch. */
function startCaller(opts: StartOptions): { sessionId?: string; launchId?: string } | undefined {
  if (opts.sessionId) return { sessionId: opts.sessionId };
  if (opts.launchId) return { launchId: opts.launchId };
  return undefined;
}

export class BrowserService {
  /** Live connections use branded ConnectionKey values, never bare profile names. */
  private connections = new Map<ConnectionKey, ProfileConnection>();
  private forkingProfiles = new Set<string>();

  // Per-task storage for console, errors, network, downloads
  private consoleLogs = new Map<string, import('./types.js').ConsoleEntry[]>();
  private pageErrors = new Map<string, import('./types.js').ErrorEntry[]>();
  private networkRequests = new Map<string, import('./types.js').NetworkRequest[]>();
  private pendingDownloads = new Map<string, { path: string; filename?: string; completed: boolean }>();
  private enabledSessions = new Map<string, Set<string>>(); // sessionId -> enabled domains
  /** Keep backend node refs on live Task objects, outside persisted state; their ids depend on this
   * daemon's CDP session. */
  private refNodes = new WeakMap<Task, Map<string, Map<number, RefNode>>>();

  /** Profile -> when a `touchTask` last persisted tasks.json for it. */
  private lastTouchPersist = new Map<string, number>();
  /** Coalescing window for the `touchTask` write. See {@link touchTask}. */
  private static readonly TOUCH_PERSIST_INTERVAL_MS = 60_000;
  /** Runtime key -> when a bulk soft attach last failed for it. See {@link rehydrateAllFromDisk}. */
  private attachMisses = new Map<ConnectionKey, number>();
  /** How long a failed bulk soft attach is not retried. */
  private static readonly ATTACH_RETRY_MS = 5 * 60_000;
  /** `--snapshot`: how long a navigation an action started may take to load before the snapshot describes the page as-is. */
  private static readonly SNAPSHOT_LOAD_TIMEOUT_MS = 3_000;
  /** `--snapshot`: how long after a click/type/press to watch for a navigation to begin. */
  private static readonly SNAPSHOT_NAVIGATION_GRACE_MS = 150;
  /** `--snapshot`, no navigation: the DOM must be still for this long before the listing is taken. */
  private static readonly SNAPSHOT_DOM_QUIET_MS = 150;
  /** `--snapshot`, no navigation: the longest a busy DOM or network can postpone the listing. */
  private static readonly SNAPSHOT_DOM_QUIET_CAP_MS = 1_500;
  /** `--snapshot`, no navigation: no request in flight for this long counts as the fetch being done. */
  private static readonly SNAPSHOT_NETWORK_IDLE_MS = 200;
  /** `--snapshot` after an in-page navigation: how long to wait for the router to render before an unchanged DOM counts as settled. */
  private static readonly SNAPSHOT_SAME_DOCUMENT_RENDER_MS = 500;

  /** Serialize URL reopen/create to prevent duplicate tabs; disjoint task: and create: namespaces avoid
   * nested deadlocks. */
  private critical = new Map<string, Promise<unknown>>();

  /** Serialize calls sharing a key, preserving each result/error; failed calls cannot wedge the queue
   * and idle keys expire. */
  private async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.critical.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.critical.set(key, tail);
    try {
      return await run;
    } finally {
      // Only the last link clears the entry; a newer waiter has replaced it.
      if (this.critical.get(key) === tail) this.critical.delete(key);
    }
  }

  /** Find live, owned, non-borrowed tabs showing the canonical URL; never match user tabs or other
   * tasks. */
  private findOwnedTabShowing(
    task: Task,
    url: string,
    liveTargets: Array<{ targetId: string; type: string; url: string }>,
  ): { shortId: string; targetId: string } | undefined {
    const borrowed = new Set(task.borrowedTabs ?? []);
    const wanted = canonicalTabUrl(url);
    const liveById = new Map(
      liveTargets.filter((t) => t.type === 'page').map((t) => [t.targetId, t]),
    );
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      if (borrowed.has(shortId)) continue;
      const live = liveById.get(cdpId);
      if (!live) continue; // registered but gone from the browser — not reopenable
      if (canonicalTabUrl(live.url) === wanted) return { shortId, targetId: cdpId };
    }
    return undefined;
  }

  /** Reload an owned matching tab without stealing focus; return its short id, or undefined when none
   * matches. */
  private async reopenOwnedTab(
    conn: CdpProfileConnection,
    task: Task,
    url: string,
    opts: ActionOpts = {},
  ): Promise<{ tabId: string } | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const match = this.findOwnedTabShowing(task, url, targetInfos);
    if (!match) return undefined;

    const sessionId = await this.getSessionId(conn, match.targetId);
    // Real reload of the SAME document. If it throws, the ids are left exactly as
    // they were and the error surfaces — never a success that didn't happen.
    await this.loadSettled(conn, sessionId, opts, () => conn.cdp.send('Page.reload', {}, sessionId));
    // Mark current without foreground activation (no Target.activateTarget).
    task.currentTabId = match.shortId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: match.shortId };
  }

  async start(profileName: string, opts: StartOptions = {}): Promise<StartResult> {
    // Lock named starts globally by task name, matching findTaskByHandle; a separate namespace avoids
    // nested deadlocks.
    if (opts.taskName) {
      return this.runExclusive(`namedstart:${opts.taskName}`, () =>
        this.startBody(profileName, opts),
      );
    }
    // Two unnamed starts from one agent at once: the second goes on in the
    // task the first opened instead of minting a second one.
    const caller = startCaller(opts);
    if (caller && !opts.fresh) {
      return this.runExclusive(`callerstart:${caller.sessionId ?? caller.launchId}:${profileName}`, () =>
        this.startBody(profileName, opts),
      );
    }
    return this.startBody(profileName, opts);
  }

  private async startBody(profileName: string, opts: StartOptions): Promise<StartResult> {
    // Consent gate, before anything is resolved or launched. This is the
    // authoritative one: gating only the `browser start` COMMAND left the ~18
    // page verbs that create a browser implicitly (navigate, click, screenshot,
    // …) able to open a browser on a machine whose owner never opted in.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });
    assertBrowserHomeReady();

    // Registry decides WHERE. Local if this device declares the name; a peer's
    // profile is refused here, since only the peer may check its own consent;
    // fail loud if nobody declares it. Never auto-create a local browser under
    // a name that means a logged-in browser somewhere else.
    const routed = resolveBrowserTarget(profileName, {
      endpointName: opts.endpointName,
      probe: opts.probe,
    });
    if (!routed.local) throw peerProfileError(profileName, routed.device);
    const composite = routed.key;
    const effectiveProfile: BrowserProfile = routed.profile;

    // Reuse the caller's sole task on the same profile/endpoint; prefer session identity because
    // workers can share launch ids.
    const caller = startCaller(opts);
    if (!opts.taskName && !opts.fresh && caller) {
      const endpoint = parseConnectionKey(composite).endpoint;
      const own = [];
      for (const found of this.listTasksForCaller(caller)) {
        if (!keyBelongsToProfile(found.key, profileName) || parseConnectionKey(found.key).endpoint !== endpoint) continue;
        if ((await this.reuseHealthyConnection(found.key)) === found.conn) own.push(found);
      }
      if (own.length === 1) return this.retryNamedStart(own[0], profileName, routed, { ...opts, taskName: own[0].task.name });
    }

    const taskId = generateTaskId();
    let taskName: string;
    if (opts.taskName) {
      const existing = this.findTaskByHandle(opts.taskName);
      if (existing) {
        // Same-name start RETRY: reuse the existing task rather than
        // erroring — but only when it is genuinely the same task. A different
        // profile, endpoint, or caller identity is a real conflict and must NOT
        // silently acquire someone else's task.
        return this.retryNamedStart(existing, profileName, routed, opts);
      }
      taskName = opts.taskName;
    } else {
      // Address by the short machine id — no word-salad. Status shows `label`.
      taskName = taskId;
    }
    const taskLabel = deriveTaskLabel({ title: opts.title, url: opts.url });

    const reused = await this.reuseProfileConnection(profileName, composite, routed.local);
    let conn = reused?.conn;
    let effectiveKey: ConnectionKey = reused?.key ?? composite;

    // Fork is a local Electron chrome-data mint. Never fork a tunnelled
    // connection — that would launch a logged-out browser on THIS box.
    if (conn && routed.local && shouldForkProfile(routed.kind, conn)) {
      if (this.forkingProfiles.has(composite)) {
        while (this.forkingProfiles.has(composite)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const existingFork = this.findAvailableFork(composite);
        if (existingFork) {
          conn = existingFork.conn;
          effectiveKey = existingFork.name;
        } else {
          throw new Error(`Fork in progress but no available fork found for "${composite}"`);
        }
      } else {
        this.forkingProfiles.add(composite);
        try {
          const { forkName, connection } = await this.forkElectronProfile(effectiveProfile, composite);
          conn = connection;
          effectiveKey = forkName;
        } finally {
          this.forkingProfiles.delete(composite);
        }
      }
    } else if (!conn) {
      adoptLegacyRuntimeIfLocal(
        routed.local,
        profileName,
        composite,
        getBrowserRuntimeDir(),
      );
      conn = await this.openConnection(
        effectiveProfile,
        routed.target,
        composite,
        profileName,
        { persistRemote: !routed.local },
      );
      effectiveKey = composite;
    }
    if (!conn) {
      throw new Error(`Could not connect to profile "${profileName}"`);
    }
    if (!conn.profile) conn.profile = profileName;

    // With --no-startup-window, bare start needs a blank tab when none exist; register it so done/stop
    // can close it.
    let startupBlankTargetId: string | undefined;
    if (!opts.url && !conn.electron && conn.backend !== 'arc-native' && conn.backend !== 'bidi') {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ type: string }>;
      };
      if (!targetInfos.some((t) => t.type === 'page')) {
        const created = await this.createPageTarget(conn, {
          url: 'about:blank',
        });
        startupBlankTargetId = created.targetId;
        this.invalidateTargetCache(conn);
      }
    }

    const now = Date.now();
    const task: Task = {
      id: taskId,
      name: taskName,
      label: taskLabel,
      profile: effectiveKey,
      tabs: {},
      currentTabId: undefined,
      createdAt: now,
      // A brand-new task has done exactly one thing — start — so its last
      // action is its creation. The reaper's idle window runs from here.
      lastActionAt: now,
      pid: conn.pid,
      // Identity is forwarded from the caller (see resolveTaskIdentity): WHO
      // (owner), WHICH run (launchId), and WHICH agent session (sessionId).
      // Resolving daemon-side would attribute every task to the shared daemon's
      // actor.
      ...resolveTaskIdentity(
        { actor: opts.actor, launchId: opts.launchId, sessionId: opts.sessionId },
        () => resolveActor().id,
      ),
      ...(opts.fleetRemote ? { fleetRemote: true as const } : {}),
    };

    if (conn.backend === 'arc-native') {
      const selected = await this.runExclusive('arc-native:host-app', async () => {
        const agent = await this.ensureArcAgentWindow();
        return this.resolveArcSpace(
          conn.arcProfile,
          (await enumerateArcSpaces()).filter((space) => space.windowId === agent.windowId),
        );
      });
      task.arcNative = {
        profileId: conn.arcProfile.profileId,
        windowId: selected.windowId,
        spaceId: selected.spaceId,
        spaceTitle: selected.spaceTitle,
        tabs: {},
        agentWindow: true,
      };
    }

    if (startupBlankTargetId) {
      const shortId = generateShortId();
      task.tabs[shortId] = startupBlankTargetId;
      task.currentTabId = shortId;
    }

    // For Electron, get the existing window as the tab
    if (conn.electron && conn.backend !== 'arc-native' && conn.backend !== 'bidi') {
      const windowId = await this.getOrCreateWindow(conn);
      if (windowId) {
        const shortId = generateShortId();
        task.tabs[shortId] = windowId;
        task.currentTabId = shortId;
      }
    }

    conn.tasks.set(taskName, task);
    await this.saveTaskState(effectiveKey, conn.tasks);

    // The daemon log is read by humans: bare name only.
    emit('browser.launch', { profile: profileName, task: taskName, pid: conn.pid });

    // Carry the real open result: reclaiming an abandoned tab must not report a newly created page.
    let tabId: string | undefined;
    let firstOpen: PageOpenResult | undefined;
    if (opts.url && conn.backend === 'bidi') {
      // Firefox: the implicit first navigate opens a fresh tab (no adopt path —
      // Firefox tabs aren't shared across abandoned tasks the way CDP ones are).
      const result = await this.navigate(taskName, opts.url, effectiveKey);
      tabId = result.tabId;
      firstOpen = { tabId: result.tabId, created: result.created, refreshed: result.refreshed, message: result.message };
    } else if (opts.url && conn.backend !== 'arc-native' && conn.backend !== 'bidi' && !conn.electron && conn.browserType !== 'arc') {
      const adopted = opts.fresh ? undefined : await this.adoptTabShowing(conn, opts.url);
      const targetId =
        adopted ?? (await this.createPageTarget(conn, { url: opts.url })).targetId;
      const shortId = generateShortId();
      task.tabs[shortId] = targetId;
      task.currentTabId = shortId;
      this.invalidateTargetCache(conn);
      await this.saveTaskState(effectiveKey, conn.tasks);
      tabId = shortId;
      firstOpen = { tabId: shortId, created: !adopted, refreshed: false };
      // Like every action, start returns on the page it opened, so a chained
      // `browser click --text …` does not search a document still loading.
      if (opts.url !== 'about:blank') await this.waitForDocument(conn, task, shortId);
    } else if (opts.url && (conn.backend === 'arc-native' || conn.electron || conn.browserType === 'arc')) {
      // Electron and Arc must reuse an existing target; carry navigate's actual result instead of
      // claiming a new tab.
      const result = await this.navigate(taskName, opts.url, effectiveKey);
      tabId = result.tabId;
      firstOpen = { tabId: result.tabId, created: result.created, refreshed: result.refreshed, message: result.message };
    }

    return {
      task: taskId,
      name: taskName,
      tabId,
      profile: profileName,
      key: effectiveKey,
      device: routed.device,
      firstOpen,
    };
  }

  /** Return whether any task on this connection already owns the CDP target. */
  private targetIsClaimed(conn: ProfileConnection, targetId: string): boolean {
    for (const t of conn.tasks.values()) {
      if (Object.values(t.tabs).includes(targetId)) return true;
    }
    return false;
  }

  /** Return only task-owned targets eligible for closing; borrowed tabs predate the task and must
   * survive it. */
  private closeableTargetIds(task: Task): string[] {
    const borrowed = new Set(task.borrowedTabs ?? []);
    return Object.entries(task.tabs)
      .filter(([shortId]) => !borrowed.has(shortId))
      .map(([, cdpId]) => cdpId);
  }

  /** Borrow unclaimed matching/empty tabs or an explicitly filtered target; reload may discard page
   * state, but borrowing never grants close ownership. */
  private async pickReusableTargetWithoutCreate(
    conn: CdpProfileConnection,
    url: string,
  ): Promise<string | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
    };
    const owned = new Set<string>();
    for (const t of conn.tasks.values()) {
      for (const id of Object.values(t.tabs)) owned.add(id);
    }
    let free = targetInfos.filter((t) => t.type === 'page' && !owned.has(t.targetId));

    // Honor targetFilter when borrowing; an unmatched explicit filter must refuse instead of taking an
    // unrelated tab.
    const parsed = parseTargetFilter(conn.targetFilter);
    if (parsed) {
      const needle = parsed.value.toLowerCase();
      free = free.filter((t) =>
        ((parsed.kind === 'url' ? t.url : t.title) ?? '').toLowerCase().includes(needle)
      );
      if (free.length === 0) return undefined;
    }

    const wanted = canonicalTabUrl(url);
    const sameUrl = free.find((t) => canonicalTabUrl(t.url) === wanted);
    if (sameUrl) return sameUrl.targetId;
    const BLANK = new Set(['', 'about:blank', 'about:newtab', 'chrome://newtab/', 'chrome://new-tab-page/']);
    const blank = free.find((t) => BLANK.has(t.url));
    if (blank) return blank.targetId;
    // With a filter set, every remaining tab already IS the bound Space, so reuse the
    // first even when it is neither the exact URL nor blank — that is the target the
    // operator pinned. With no filter, only an exact-URL or blank tab is safe to borrow.
    return parsed ? free[0]?.targetId : undefined;
  }

  /** Transfer matching tabs only from provably abandoned tasks; never adopt user or live-task tabs.
   * Fresh starts skip adoption. */
  private async adoptTabShowing(
    conn: CdpProfileConnection,
    url: string
  ): Promise<string | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };

    const wanted = canonicalTabUrl(url);
    const matching = new Set(
      targetInfos
        .filter((t) => t.type === 'page' && canonicalTabUrl(t.url) === wanted)
        .map((t) => t.targetId)
    );
    if (matching.size === 0) return undefined;

    const candidates: Array<{ task: Task; shortId: string; targetId: string }> = [];
    for (const task of conn.tasks.values()) {
      const borrowed = new Set(task.borrowedTabs ?? []);
      for (const [shortId, cdpId] of Object.entries(task.tabs)) {
        // Borrowed tabs cannot become owned through adoption, or a later done would close the user's
        // tab.
        if (borrowed.has(shortId)) continue;
        if (matching.has(cdpId)) candidates.push({ task, shortId, targetId: cdpId });
      }
    }
    if (candidates.length === 0) return undefined;

    const live = resolveLiveIdentities();
    for (const { task, shortId, targetId } of candidates) {
      // An in-flight capture means the task is in use whatever its owner looks
      // like — same guard the reaper applies before stopping anything.
      if (this.recordings.has(task.name)) continue;
      if (!(await taskOwnerIsGone(task, live))) continue;
      // Re-check ownership after awaiting liveness; concurrent starts must not claim the same target.
      if (task.tabs[shortId] !== targetId) continue;

      delete task.tabs[shortId];
      delete task.refDescriptors?.[shortId];
      if (task.currentTabId === shortId) {
        const remaining = Object.keys(task.tabs);
        task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
      }

      try {
        await conn.cdp.send('Target.activateTarget', { targetId });
      } catch {
        // Bringing the tab to the front is cosmetic and not every endpoint
        // implements activateTarget; the tab is reclaimed either way.
      }
      return targetId;
    }

    return undefined;
  }

  /** Return live tasks across connections; callers must treat Task objects as read-only and act through
   * stop. */
  listTasks(): Array<{ profile: ConnectionKey; task: Task }> {
    const out: Array<{ profile: ConnectionKey; task: Task }> = [];
    for (const [key, conn] of this.connections) {
      for (const task of conn.tasks.values()) {
        out.push({ profile: conn.key ?? key, task });
      }
    }
    return out;
  }

  /** Reap tasks under hygiene.ts owner-liveness and idle policy; shared by the daemon tick and browser
   * prune. */
  async reapAbandoned(opts: ReapOptions = {}): Promise<ReapResult> {
    // `listTasks` reads live connections only. A daemon that restarted holds
    // none until something rehydrates, so reap after the same soft attach that
    // `status` does; an unreadable runtime dir is left for `status` to report.
    await this.rehydrateAllFromDisk(undefined, () => {});
    return reapAbandonedTasks(this, opts);
  }

  async stop(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    // Rehydrate from tasks.json when the daemon restarted and lost RAM state.
    try {
      await this.findTask(taskName);
    } catch {
      // findTask throws when truly gone; fall through to the miss return.
    }
    for (const [key, conn] of this.connections) {
      const task = this.lookupTaskOnConn(conn, taskName);
      if (task) {
        // Map key may be task.name, not the caller-supplied handle.
        const mapKey = this.taskMapKey(conn, task) ?? taskName;
        // Get domains from tabs before closing (for history)
        const domains = new Set<string>();

        if (conn.backend === 'arc-native') {
          // Resolve exact durable refs for history. Missing/moved tabs are not
          // adopted and never become candidates for a best-effort close.
          for (const ref of Object.values(this.requireArcTask(task).tabs)) {
            const live = await resolveArcTab(ref);
            if (live?.url) {
              try {
                const domain = new URL(live.url).hostname.replace(/^www\./, '');
                if (domain && domain !== 'blank') domains.add(domain);
              } catch { /* invalid URL */ }
            }
          }
          await this.saveToHistory(task, Array.from(domains));
          await this.closeArcNativeTabs(conn, task);
        } else if (conn.backend === 'bidi') {
          try {
            for (const tab of await this.listFirefoxTaskTabs(conn, task)) {
              try {
                const domain = new URL(tab.url).hostname.replace(/^www\./, '');
                if (domain && domain !== 'blank') domains.add(domain);
              } catch { /* invalid URL */ }
            }
          } catch { /* Firefox not responding */ }
          await this.saveToHistory(task, Array.from(domains));
          await this.closeFirefoxTabs(conn, task);
        } else {
          try {
            const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
              targetInfos: Array<{ targetId: string; url: string }>;
            };
            for (const cdpId of Object.values(task.tabs)) {
              const target = targetInfos.find((t) => t.targetId === cdpId);
              if (target?.url) {
                try {
                  const domain = new URL(target.url).hostname.replace(/^www\./, '');
                  if (domain && domain !== 'blank') domains.add(domain);
                } catch {
                  // invalid URL
                }
              }
            }
          } catch {
            // CDP not responding
          }

          // Save to history before closing
          await this.saveToHistory(task, Array.from(domains));

          // Close task's tabs (not the window - it's shared, and not a tab the
          // task merely borrowed - that one was open before the task existed).
          await Promise.all(
            this.closeableTargetIds(task).map((cdpId) =>
              conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {
                // Tab already closed
              })
            )
          );
          for (const cdpId of Object.values(task.tabs)) {
            conn.sessionCache.delete(cdpId);
          }
          this.invalidateTargetCache(conn);
        }

        this.recordTaskHistory(task, true);
        conn.tasks.delete(mapKey);
        await this.saveTaskState(key, conn.tasks);

        // The daemon log is read by humans: bare profile name.
        const bareProfile = conn.profile ?? parseConnectionKey(key).profile;
        emit('browser.close', { profile: bareProfile, task: task.name });

        if (conn.forkedFrom && conn.tasks.size === 0) {
          if (conn.backend === 'bidi') {
            conn.bidi.close();
            if (conn.pid) killChrome(conn.pid);
          } else if (conn.backend !== 'arc-native') {
            conn.cdp.close();
            killChrome(conn.pid);
          }
          conn.cleanup?.();
          this.connections.delete(key);
          clearProfileRuntime(key);
        }

        return { ok: true, profile: bareProfile };
      }
    }

    return { ok: false };
  }

  async done(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    return this.stop(taskName);
  }

  async stopProfile(
    profileRef: ProfileName | ConnectionKey,
    opts: { fleetRemote?: boolean; actor?: string } = {},
  ): Promise<void> {
    // Task-less stop is destructive and bypasses task resolution, so it needs its own per-request
    // consent gate.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });
    assertBrowserHomeReady();

    // Resolve exact runtime keys or every connection for the bare profile, so teardown also cleans
    // remote tunnels.
    const keys = [...this.connections.keys()].filter(
      (k) => k === profileRef || keyBelongsToProfile(k, profileRef),
    );
    for (const key of keys) {
      const conn = this.connections.get(key);
      if (!conn) continue;
      // Native Arc connections: close owned tabs but NEVER kill the Arc process.
      // The CLI does not own the Arc process — the user started it.
      if (conn.backend === 'arc-native') {
        for (const task of conn.tasks.values()) {
          await this.closeArcNativeTabs(conn, task);
        }
        this.connections.delete(key);
        clearProfileRuntime(key);
        continue;
      }
      // Firefox: close the BiDi socket and kill the Firefox WE launched (pid !=
      // 0). An attached Firefox the user started (pid 0) is left running — the
      // CLI does not own that process, same as Arc.
      if (conn.backend === 'bidi') {
        conn.bidi.close();
        if (conn.pid) killChrome(conn.pid);
        conn.cleanup?.();
        this.connections.delete(key);
        clearProfileRuntime(key);
        continue;
      }
      conn.cdp.close();
      killChrome(conn.pid);
      conn.cleanup?.();
      this.connections.delete(key);
      clearProfileRuntime(key);
    }

    // Kill stale processes and clean runtime dirs for every composite and
    // fork entry belonging to this profile (including `.N` forks left by
    // earlier daemon sessions that the connection loop above didn't cover).
    for (const dir of listProfileCacheDirs(parseConnectionKey(profileRef).profile)) {
      const dirName = path.basename(dir);
      const meta = readProfileRuntimeMeta(dirName);
      if (meta?.pid && meta.pid !== 0 && isProcessAlive(meta.pid, meta.command)) {
        killChrome(meta.pid);
      }
      clearProfileRuntime(dirName);
    }
  }

  async navigate(
    taskId: string,
    url: string,
    profileRef?: ProfileName | ConnectionKey,
    opts: ActionOpts = {},
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string; snapshot?: PageSnapshot }> {
    const { conn, task } = await this.findTask(taskId, profileRef);
    // Serialize the reopen/create section so two concurrent navigates for one
    // task don't both miss the "already open?" check and open duplicates.
    const result = await this.runExclusive(`task:${task.profile}:${task.name}`, () =>
      this.navigateLocked(conn, task, url, opts),
    );
    if (opts.snapshot) return { ...result, snapshot: result.snapshot ?? (await this.snapshotPage(conn, task, result.tabId)) };
    if (opts.wait) await this.waitForDocument(conn, task, result.tabId);
    return result;
  }

  private async navigateLocked(
    conn: ProfileConnection,
    task: Task,
    url: string,
    opts: ActionOpts,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string; snapshot?: PageSnapshot }> {
    this.maybeUpdateLabelFromUrl(conn, task, url);

    // Native Arc backend: route through the native driver instead of CDP.
    if (conn.backend === 'arc-native') {
      return this.navigateArcNative(conn, task, url);
    }
    // Firefox BiDi backend.
    if (conn.backend === 'bidi') {
      return this.navigateFirefox(conn, task, url);
    }
    requireCdp(conn, 'navigate');

    // Same-task reopen: the URL is already live in a tab this task
    // owns → reload THAT tab in place and keep its id, before the create/reuse
    // paths below. Chrome and Arc alike; Electron drives one window and never
    // has a second owned tab to match, so this is a no-op there.
    const reopened = await this.reopenOwnedTab(conn, task, url, opts);
    if (reopened) {
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: reopened.tabId, created: false });
      const result = { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
      return opts.snapshot ? { ...result, snapshot: await this.snapshotPage(conn, task, reopened.tabId, { settled: true }) } : result;
    }

    // If we have a current tab, navigate in it (reuse)
    const currentShortId = task.currentTabId;
    if (currentShortId && task.tabs[currentShortId]) {
      const cdpTargetId = task.tabs[currentShortId];
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await this.loadSettled(conn, sessionId, opts, () => conn.cdp.send('Page.navigate', { url }, sessionId));
      await this.saveTaskState(task.profile, conn.tasks);
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: currentShortId, created: false });
      const result = { tabId: currentShortId, url, created: false, refreshed: false };
      return opts.snapshot ? { ...result, snapshot: await this.snapshotPage(conn, task, currentShortId, { settled: true }) } : result;
    }

    // No current tab - create one
    if (conn.electron) {
      const cdpTargetId = conn.windowId;
      if (!cdpTargetId) {
        throw new Error('No existing tab to navigate in Electron app');
      }
      const shortId = generateShortId();
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await this.loadSettled(conn, sessionId, opts, () => conn.cdp.send('Page.navigate', { url }, sessionId));
      task.tabs[shortId] = cdpTargetId;
      task.currentTabId = shortId;
      await this.saveTaskState(task.profile, conn.tasks);
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: shortId, created: true });
      return { tabId: shortId, url, created: true, refreshed: false };
    }

    // Arc supports Page.navigate but crashes on Target.createTarget; reuse an existing page.
    if (conn.browserType === 'arc') {
      const reusable = await this.pickReusableTargetWithoutCreate(conn, url);
      if (reusable) {
        const shortId = generateShortId();
        const sessionId = await this.getSessionId(conn, reusable);
        // Check and claim without an await between them so concurrent navigation cannot share one tab.
        if (this.targetIsClaimed(conn, reusable)) {
          throw arcNotDrivableError(conn.profile);
        }
        task.tabs[shortId] = reusable;
        // Borrowed, not opened: this tab was in the browser before the task and
        // must survive `done`. See Task.borrowedTabs.
        task.borrowedTabs = [...(task.borrowedTabs ?? []), shortId];
        task.currentTabId = shortId;
        try {
          await this.loadSettled(conn, sessionId, opts, () => conn.cdp.send('Page.navigate', { url }, sessionId));
        } catch (err) {
          // Release the claim we took optimistically, so a failed navigate does
          // not leave the task holding a tab it never drove.
          delete task.tabs[shortId];
          task.borrowedTabs = (task.borrowedTabs ?? []).filter((id) => id !== shortId);
          if (task.currentTabId === shortId) task.currentTabId = undefined;
          throw err;
        }
        this.invalidateTargetCache(conn);
        await this.saveTaskState(task.profile, conn.tasks);
        emit('browser.navigate', {
          profile: task.profile,
          task: task.name,
          url,
          tabId: shortId,
          created: false,
        });
        return { tabId: shortId, url, created: false, refreshed: false };
      }
      // Nothing safe to reuse -- fall through to the actionable refusal rather
      // than taking over a page the user is reading.
    }

    // Chrome: create new tab
    const result = await this.createPageTarget(conn, { url });

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId;
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: shortId, created: true });
    return { tabId: shortId, url, created: true, refreshed: false };
  }

  async tabAdd(
    taskId: string,
    url: string,
    profileRef?: ProfileName | ConnectionKey,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    const { conn, task } = await this.findTask(taskId, profileRef);
    return this.runExclusive(`task:${task.profile}:${task.name}`, () =>
      this.tabAddLocked(conn, task, url),
    );
  }

  private async tabAddLocked(
    conn: ProfileConnection,
    task: Task,
    url: string,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    if (conn.backend === 'arc-native') {
      return this.navigateArcNative(conn, task, url, true);
    }
    if (conn.backend === 'bidi') {
      return this.navigateFirefox(conn, task, url, true);
    }
    requireCdp(conn, 'createTab');
    if (conn.electron) {
      throw new Error('Electron apps do not support opening additional tabs');
    }

    // Same-task reopen: reopening a URL already live in one of this
    // task's own tabs refreshes THAT tab rather than opening a duplicate. The
    // no-match case below stays `tab add`'s intentional create-a-new-tab
    // semantics — distinct from `navigate`, which reuses the current tab.
    const reopened = await this.reopenOwnedTab(conn, task, url);
    if (reopened) {
      return { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
    }

    const result = await this.createPageTarget(conn, { url });

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId; // new tab becomes current
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url, created: true, refreshed: false };
  }

  async tabFocus(taskId: string, tabHint: string): Promise<{ tabId: string }> {
    const { conn, task } = await this.findTask(taskId);
    const resolvedTabId = await this.resolveTabHint(conn, task, tabHint);
    if (conn.backend === 'arc-native') {
      await this.runExclusive('arc-native:host-app', async () => {
        const ref = this.requireArcTask(task).tabs[resolvedTabId];
        if (!ref) throw new Error(`Tab ${resolvedTabId} not found`);
        await selectArcTab(ref);
        task.currentTabId = resolvedTabId;
        await this.saveTaskState(task.profile, conn.tasks);
      });
      return { tabId: resolvedTabId };
    }
    if (conn.backend === 'bidi') {
      await bidiActivate(conn.bidi, this.firefoxContext(task, resolvedTabId));
      task.currentTabId = resolvedTabId;
      await this.saveTaskState(task.profile, conn.tasks);
      return { tabId: resolvedTabId };
    }
    requireCdp(conn, 'enumerate');
    await conn.cdp.send('Target.activateTarget', { targetId: task.tabs[resolvedTabId] });
    task.currentTabId = resolvedTabId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: resolvedTabId };
  }

  async tabList(taskId: string): Promise<Array<{ id: string; url: string; title: string; current: boolean }>> {
    const { conn, task } = await this.findTask(taskId);
    if (conn.backend === 'arc-native') {
      return (await this.listArcTaskTabs(task)).map((tab) => ({ ...tab, current: tab.current === true }));
    }
    if (conn.backend === 'bidi') {
      return (await this.listFirefoxTaskTabs(conn, task)).map((tab) => ({
        id: tab.id, url: tab.url, title: tab.title, current: tab.current === true,
      }));
    }
    requireCdp(conn, 'enumerate');
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: Array<{ id: string; url: string; title: string; current: boolean }> = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          current: shortId === task.currentTabId,
        });
      }
    }
    return tabs;
  }

  /** List all profile tabs without mutation; owned tabs include task handles, other tabs expose only
   * browser ids. */
  async profileTabs(taskId: string): Promise<ProfileTabInfo[]> {
    const { conn, task } = await this.findTask(taskId);
    const owners = new Map<string, { owner: Task; shortId: string }>();
    for (const [, owner] of conn.tasks) {
      const entries = conn.backend === 'arc-native'
        ? Object.entries(owner.arcNative?.tabs ?? {}).map(([shortId, ref]) => [shortId, ref.tabId] as const)
        : Object.entries(owner.tabs);
      for (const [shortId, nativeId] of entries) owners.set(nativeId, { owner, shortId });
    }
    const row = (nativeId: string, url: string, title: string): ProfileTabInfo => {
      const owned = owners.get(nativeId);
      if (!owned) return { id: nativeId, url, title };
      return {
        id: owned.shortId,
        url,
        title,
        task: owned.owner.name,
        current: owned.owner === task && owned.shortId === task.currentTabId,
      };
    };

    if (conn.backend === 'arc-native') {
      const native = this.requireArcTask(task);
      const space = (await enumerateArcSpaces()).find(
        (candidate) => candidate.windowId === native.windowId && candidate.spaceId === native.spaceId,
      );
      if (!space) {
        throw new Error(
          `Arc Space "${native.spaceTitle}" is not open in its original window (${native.windowId}); ` +
            'open it in Arc and retry.',
        );
      }
      return space.tabs.map((tab) => row(tab.tabId, tab.url, tab.title));
    }
    if (conn.backend === 'bidi') {
      const rows: ProfileTabInfo[] = [];
      for (const context of await bidiTopLevelContexts(conn.bidi)) {
        let title = '';
        try {
          title = String(await bidiEvaluate(conn.bidi, context.context, 'document.title'));
        } catch {
          /* about: pages or a mid-navigation context — url is enough */
        }
        rows.push(row(context.context, context.url, title));
      }
      return rows;
    }
    requireCdp(conn, 'enumerate');
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    return targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => row(target.targetId, target.url, target.title));
  }

  private async resolveTabHint(conn: ProfileConnection, task: Task, hint: string): Promise<string> {
    // Exact match
    if (task.tabs[hint]) return hint;

    // Prefix match
    const byPrefix = Object.keys(task.tabs).filter((id) => id.startsWith(hint));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${byPrefix.length} tabs`);
    }

    // Native Arc addresses owned tabs only by the task's stable short id. URL
    // and title are display data and must never become fallback identities.
    if (conn.backend === 'arc-native') throw new Error(`Tab "${hint}" not found`);
    // Firefox tabs are addressed by the task's stable short id too.
    if (conn.backend === 'bidi') throw new Error(`Tab "${hint}" not found`);

    // URL substring match
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string }>;
    };
    const matches: string[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target && target.url.includes(hint)) {
        matches.push(shortId);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${matches.length} tabs by URL`);
    }

    throw new Error(`Tab "${hint}" not found`);
  }

  private resolveCurrentTab(task: Task): string {
    const tabIds = Object.keys(task.tabs);
    const id = task.currentTabId ?? tabIds[tabIds.length - 1];
    if (!id) throw new Error('No tabs open for this task');
    return id;
  }

  private getCdpTargetId(task: Task, shortId: string): string {
    const cdpId = task.tabs[shortId];
    if (!cdpId) throw new Error(`Tab ${shortId} not found`);
    return cdpId;
  }

  async tabs(taskId?: string, profileRef?: ProfileName | ConnectionKey): Promise<TabInfo[]> {
    if (taskId) {
      const { conn, task } = await this.findTask(taskId, profileRef);
      if (conn.backend === 'arc-native') return this.listArcTaskTabs(task);
      if (conn.backend === 'bidi') return this.listFirefoxTaskTabs(conn, task);
      return this.getTabsForTask(conn.cdp, task);
    }

    const allTabs: TabInfo[] = [];
    for (const [, conn] of this.connections) {
      for (const [, task] of conn.tasks) {
        const tabs = conn.backend === 'arc-native'
          ? await this.listArcTaskTabs(task)
          : conn.backend === 'bidi'
            ? await this.listFirefoxTaskTabs(conn, task)
            : await this.getTabsForTask(conn.cdp, task);
        allTabs.push(...tabs);
      }
    }
    return allTabs;
  }

  async tabClose(taskId: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);

    if (conn.backend === 'arc-native') {
      await this.runExclusive('arc-native:host-app', async () => {
        await this.reconcileArcCreateIntents(conn, task);
        const native = this.requireArcTask(task);
        const ids = tabHint === undefined
          ? Object.keys(native.tabs)
          : [await this.resolveTabHint(conn, task, tabHint)];
        for (const shortId of ids) {
          const ref = native.tabs[shortId];
          if (ref) await closeArcTab(ref);
          delete native.tabs[shortId];
          delete task.tabs[shortId];
          delete task.refDescriptors?.[shortId];
        }
        if (!task.currentTabId || ids.includes(task.currentTabId)) {
          const remaining = Object.keys(native.tabs);
          task.currentTabId = remaining.at(-1);
        }
        await this.saveTaskState(task.profile, conn.tasks);
      });
      return;
    }
    if (conn.backend === 'bidi') {
      const borrowed = new Set(task.borrowedTabs ?? []);
      const ids = tabHint === undefined
        ? Object.keys(task.tabs)
        : [await this.resolveTabHint(conn, task, tabHint)];
      for (const shortId of ids) {
        const context = task.tabs[shortId];
        // A borrowed tab is released, not closed — it outlives this task.
        if (context && !borrowed.has(shortId)) {
          try { await bidiCloseTab(conn.bidi, context); } catch { /* already closed */ }
        }
        delete task.tabs[shortId];
        delete task.refDescriptors?.[shortId];
        task.borrowedTabs = (task.borrowedTabs ?? []).filter((id) => id !== shortId);
      }
      if (!task.currentTabId || ids.includes(task.currentTabId)) {
        task.currentTabId = Object.keys(task.tabs).at(-1);
      }
      await this.saveTaskState(task.profile, conn.tasks);
      return;
    }
    requireCdp(conn, 'closeTab');

    if (tabHint !== undefined) {
      const shortId = await this.resolveTabHint(conn, task, tabHint);
      const cdpId = task.tabs[shortId];
      if (cdpId) {
        // A borrowed tab is released, not closed — it outlives this task.
        if (!(task.borrowedTabs ?? []).includes(shortId)) {
          await conn.cdp.send('Target.closeTarget', { targetId: cdpId });
        }
        conn.sessionCache.delete(cdpId);
        delete task.tabs[shortId];
        // Drop the borrow record with the tab it names, or it outlives every tab
        // it ever described and grows unbounded in the persisted task state.
        task.borrowedTabs = (task.borrowedTabs ?? []).filter((id) => id !== shortId);
        // Update currentTabId if we closed the current tab
        if (task.currentTabId === shortId) {
          const remaining = Object.keys(task.tabs);
          task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
        }
      }
    } else {
      // Close all tabs the task opened; borrowed ones are only released.
      await Promise.all(
        this.closeableTargetIds(task).map((cdpId) =>
          conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {})
        )
      );
      for (const cdpId of Object.values(task.tabs)) {
        conn.sessionCache.delete(cdpId);
      }
      task.tabs = {};
      task.borrowedTabs = [];
      task.currentTabId = undefined;
    }

    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);
  }

  async loadLazyParts(taskId: string, tabHint: string | undefined): Promise<number> {
    const ask = async (expression: string): Promise<unknown> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('The page did not answer within 2 s.')), 2000); });
      try {
        return await Promise.race([this.evaluate(taskId, tabHint, expression), late]);
      } finally {
        clearTimeout(timer);
      }
    };
    let left = Number(await ask(LAZY_PARTS));
    if (!left) return 0;
    try {
      for (const deadline = Date.now() + 4000; left > 0 && Date.now() < deadline;) {
        await new Promise((r) => setTimeout(r, 150));
        left = Number(await ask(LAZY_PARTS));
      }
    } finally {
      await ask(LAZY_RESTORE).catch(() => {});
    }
    return left;
  }

  /** `browser text`: the tab's title and URL, then what a reader sees in the page and its iframes. */
  async text(taskId: string, tabHint: string | undefined, select?: { css: string; attr?: string }): Promise<string> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (select) {
      // `text --css`: what an agent otherwise writes as querySelectorAll(...).map(...)
      // in `evaluate`, without a script for the shell to inspect. A property
      // (`href` resolves to the absolute URL) wins over the raw attribute.
      const read = `JSON.stringify((() => { const css = ${JSON.stringify(select.css)}, attr = ${JSON.stringify(select.attr ?? null)};
        let found; try { found = document.querySelectorAll(css); } catch { throw new Error('Invalid CSS selector ' + JSON.stringify(css)); }
        return { url: location.href, title: document.title, items: Array.from(found, (e) =>
          attr === null ? String(e.innerText ?? e.textContent ?? '') : typeof e[attr] === 'string' ? e[attr] : String(e.getAttribute(attr) ?? '')) }; })())`;
      const page = JSON.parse(String(await this.evaluate(taskId, shortId, read))) as { url: string; title: string; items: string[] };
      if (!page.items.length) throw new Error(`No element matches "${select.css}" on this page.`);
      return plainSpaces(`${page.title ? `${page.title} — ` : ''}${page.url}\n\n${page.items.map((item) => item.trim()).join('\n--\n')}`);
    }
    const header = 'JSON.stringify({ url: location.href, title: document.title })';
    if (conn.backend === 'arc-native' || conn.backend === 'bidi') {
      // Arc and Firefox read the top document only; iframes are Chromium-family for now.
      const page = JSON.parse(String(await this.evaluate(taskId, shortId,
        'JSON.stringify({ url: location.href, title: document.title, body: document.body ? document.body.innerText : "" })'))) as { url: string; title: string; body: string };
      return plainSpaces(`${page.title ? `${page.title} — ` : ''}${page.url}\n\n${page.body.trim()}`);
    }
    requireCdp(conn, 'evaluate');
    const target = await this.getTarget(conn, this.getCdpTargetId(task, shortId));
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enablePageForSession(conn, sessionId);
    const { result, exceptionDetails } = await evaluateInPage<{ result: { value?: string }; exceptionDetails?: { text?: string } }>(
      conn.cdp, { expression: header, returnByValue: true }, sessionId);
    if (exceptionDetails || typeof result.value !== 'string') throw new Error(`Could not read the page: ${exceptionDetails?.text ?? 'no document'}`);
    const page = JSON.parse(result.value) as { url: string; title: string };
    return plainSpaces(`${page.title ? `${page.title} — ` : ''}${page.url}\n\n${await pageText(conn.cdp, sessionId)}`);
  }

  async evaluate(
    taskId: string,
    tabHint: string | undefined,
    expression: string
  ): Promise<unknown> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);

    // Native Arc backend: synchronous JS only, isolated world.
    if (conn.backend === 'arc-native') {
      return this.evaluateArcNative(conn, task, shortId, expression);
    }
    // Firefox BiDi backend: async-capable, isolated realm.
    if (conn.backend === 'bidi') {
      return this.evaluateFirefox(conn, task, shortId, expression);
    }

    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    // replMode permits redeclarations but does not await completion promises; await them and propagate
    // rejections.
    type Remote = { type?: string; subtype?: string; objectId?: string; value?: unknown };
    type Thrown = { text?: string; exception?: { description?: string; value?: unknown } };
    const fail = (ex: Thrown): never => {
      throw new Error(
        ex.exception?.description ??
          (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
          ex.text ??
          'evaluate failed',
      );
    };
    const ran = await evaluateInPage<{ result: Remote; exceptionDetails?: Thrown }>(
      conn.cdp, { expression, awaitPromise: true, replMode: true }, sessionId);
    if (ran.exceptionDetails) fail(ran.exceptionDetails);
    if (!ran.result.objectId) return ran.result.value;
    if (ran.result.subtype === 'promise') {
      const settled = (await conn.cdp.send(
        'Runtime.awaitPromise',
        { promiseObjectId: ran.result.objectId, returnByValue: true },
        sessionId,
      )) as { result: Remote; exceptionDetails?: Thrown };
      if (settled.exceptionDetails) fail(settled.exceptionDetails);
      return settled.result.value;
    }
    const byValue = (await conn.cdp.send(
      'Runtime.callFunctionOn',
      { objectId: ran.result.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true },
      sessionId,
    )) as { result: Remote };
    await conn.cdp.send('Runtime.releaseObject', { objectId: ran.result.objectId }, sessionId).catch(() => {});
    return byValue.result.value;
  }

  async screenshot(
    taskId: string,
    tabHint?: string,
    outputPath?: string,
    quality: 'compressed' | 'raw' = 'compressed'
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);

    if (conn.backend === 'arc-native') {
      return this.screenshotArcNative(conn, task, runtimeKey, tabHint, outputPath, quality);
    }

    // Firefox BiDi backend: captureScreenshot on the context.
    if (conn.backend === 'bidi') {
      return this.screenshotFirefox(conn, task, runtimeKey, tabHint, outputPath, quality);
    }

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    let buffer: Buffer;
    let extension: 'png' | 'jpg';

    if (quality === 'raw') {
      // Pixel-faithful PNG, no downscale. For archived QA evidence where
      // lossy JPEG would hide rendering bugs. Files run 0.5–3 MB.
      const { data } = (await conn.cdp.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sessionId
      )) as { data: string };
      buffer = Buffer.from(data, 'base64');
      extension = 'png';
    } else {
      // Limit screenshot retries: capture at quality 60, then once at 30 if needed to fit the 100 KB
      // budget.
      const MAX_SIZE = 100 * 1024;
      const capture = async (quality: number): Promise<Buffer> => {
        const { data } = (await conn.cdp.send(
          'Page.captureScreenshot',
          { format: 'jpeg', quality },
          sessionId
        )) as { data: string };
        return Buffer.from(data, 'base64');
      };
      buffer = await capture(60);
      if (buffer.length > MAX_SIZE) buffer = await capture(30);
      extension = 'jpg';
    }
    return this.saveScreenshot(runtimeKey, task, shortId, buffer, extension, outputPath, quality);
  }

  private async saveScreenshot(
    runtimeKey: ConnectionKey,
    task: Task,
    shortId: string,
    buffer: Buffer,
    extension: 'png' | 'jpg',
    outputPath: string | undefined,
    quality: 'compressed' | 'raw',
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const sessionsDir = getProfileSessionsDir(runtimeKey, task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.${extension}`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    const dims =
      (extension === 'png' ? readPngDimensions(buffer) : readJpegDimensions(buffer)) ??
      { width: 0, height: 0 };
    emit('browser.screenshot', {
      profile: parseConnectionKey(runtimeKey).profile,
      task: task.name,
      tabId: shortId,
      path: finalPath,
      bytes: buffer.length,
      width: dims.width,
      height: dims.height,
      quality,
    });
    return { path: finalPath, bytes: buffer.length, width: dims.width, height: dims.height };
  }

  /** Export the resolved tab as PDF using screenshot path rules; print backgrounds so dark pages retain
   * their design. */
  async printToPdf(
    taskId: string,
    tabHint?: string,
    outputPath?: string
  ): Promise<{ path: string; bytes: number }> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'pdf');

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const { data } = (await conn.cdp.send(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: true },
      sessionId
    )) as { data: string };
    const buffer = Buffer.from(data, 'base64');

    const sessionsDir = getProfileSessionsDir(runtimeKey, task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.pdf`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    return { path: finalPath, bytes: buffer.length };
  }

  // Pipe screencast JPEGs into ffmpeg; duration and size caps prevent forgotten recordings from
  // filling disk.
  private recordings = new Map<string, {
    outputPath: string;
    startedAt: number;
    fps: number;
    maxBytes: number;
    durationMs: number;
    ffmpeg: import('child_process').ChildProcess;
    ffmpegStderr: () => string;
    encoderError: () => Error | undefined;
    frameCount: number;
    sessionId: string;
    conn: CdpProfileConnection;
    frameHandler: (params: unknown) => void;
    framePump: NodeJS.Timeout;
    durationTimer: NodeJS.Timeout;
    sizeCheckInterval: NodeJS.Timeout;
    stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  }>();

  async recordStart(
    taskId: string,
    tabHint?: string,
    opts: { fps?: number; duration?: number; maxMb?: number } = {}
  ): Promise<{ path: string; fps: number; durationCapSec: number; maxMb: number }> {
    if (this.recordings.has(taskId)) {
      throw new Error(`Task "${taskId}" is already recording. Call record stop first.`);
    }

    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'recording');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);

    const fps = opts.fps ?? 5;
    const durationSec = opts.duration ?? 60;
    const maxMb = opts.maxMb ?? 25;
    if (fps < 1 || fps > 30) throw new Error('--fps must be between 1 and 30');
    if (durationSec < 1 || durationSec > 3600) throw new Error('--duration must be between 1 and 3600 seconds');
    if (maxMb < 1 || maxMb > 500) throw new Error('--max-mb must be between 1 and 500');

    const recordingsDir = path.join(getProfileSessionsDir(runtimeKey, task.name), 'recordings');
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    const outputPath = path.join(recordingsDir, `${Date.now()}.webm`);

    // Resolve ffmpeg lazily so non-recording paths don't pay the import cost.
    const [{ spawn }, ffmpegPath] = await Promise.all([
      import('child_process'),
      resolveFfmpeg(),
    ]);
    // The frame pump below clocks the latest CDP paint into stdin at exactly
    // `fps`, including repeated frames while the page is static. Declare that
    // cadence to image2pipe so frame count / fps is the real capture duration.
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-framerate', String(fps),
        '-i', '-',
        '-c:v', 'libvpx-vp9',
        '-b:v', '1M',
        '-pix_fmt', 'yuv420p',
        '-y',
        outputPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
    );
    // Wait for the spawn to confirm before wiring CDP frames into a dead pipe.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        ffmpeg.off('spawn', onSpawn);
        reject(err);
      };
      const onSpawn = () => {
        ffmpeg.off('error', onError);
        resolve();
      };
      ffmpeg.once('error', onError);
      ffmpeg.once('spawn', onSpawn);
    });

    // Capture ffmpeg's own diagnostics (encoder error, bad codec, etc.) so a
    // failing encode is DIAGNOSABLE at recordStop instead of being discarded.
    // Cap the buffer so a chatty ffmpeg can't grow it unbounded.
    let stderrBuf = '';
    ffmpeg.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });
    const ffmpegStderr = () => stderrBuf;
    ffmpeg.on('error', () => { /* post-spawn errors get reported via exit code */ });

    let frameCount = 0;
    let latestFrame: Buffer | undefined;
    let stdinBlocked = false;
    let stdinError: Error | undefined;
    ffmpeg.stdin?.on('drain', () => { stdinBlocked = false; });
    ffmpeg.stdin?.on('error', (error) => { stdinError = error; });
    const writeFrame = (frame: Buffer): boolean => {
      const stdin = ffmpeg.stdin;
      if (!stdin || stdin.destroyed || stdinError || stdinBlocked) return false;
      stdinBlocked = !stdin.write(frame);
      frameCount += 1;
      return true;
    };
    const frameIntervalMs = 1000 / fps;
    let resolveFirstFrame!: () => void;
    const firstFrame = new Promise<void>((resolve) => { resolveFirstFrame = resolve; });
    const frameHandler = (params: unknown, eventSessionId?: string) => {
      if (eventSessionId !== sessionId) return;
      const p = params as { data: string; sessionId: number };
      try {
        latestFrame = Buffer.from(p.data, 'base64');
        if (frameCount === 0) {
          if (writeFrame(latestFrame)) resolveFirstFrame();
        }
      } catch {
        // ffmpeg exited; ignore writes
      }
      // Must ack every frame or CDP stops sending.
      conn.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
    };
    // CDP emits on paints, so a static page can legitimately produce only one
    // event in 15 seconds. Retain the latest real frame and clock it into the
    // encoder at --fps; new paints replace it, while quiet time still advances
    // the WebM timeline instead of collapsing to a one-frame, 0.04s artifact.
    const framePump = setInterval(() => {
      if (!latestFrame) return;
      try {
        writeFrame(latestFrame);
      } catch {
        // ffmpeg exited; recordStop reports its exit code and stderr.
      }
    }, frameIntervalMs);
    // Register BEFORE startScreencast. Chrome may emit its first frame before
    // the command response; missing that frame also misses its ack and stalls
    // the entire stream with ffmpeg's stdin still empty.
    conn.cdp.on('Page.screencastFrame', frameHandler);

    try {
      await this.enablePageForSession(conn, sessionId);
      await conn.cdp.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: 60,
          // Chrome's frames are paint-driven, not a 30fps clock. Asking for
          // every third paint can suppress the only stored frame on a static
          // page, so receive every paint and enforce --fps when writing stdin.
          everyNthFrame: 1,
          maxFramesInFlight: 1,
          // A static/low-paint page may produce no new compositor frame after
          // startScreencast. Ask Chrome to send its stored last frame so the
          // first ack can bootstrap the stream instead of leaving ffmpeg stdin
          // empty forever (confirmed live against Chrome 151).
          sendLastFrame: true,
        },
        sessionId
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Chrome produced no screencast frame within 5s; recording was not started.')),
          5000,
        );
        firstFrame.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (error) {
      conn.cdp.off('Page.screencastFrame', frameHandler);
      clearInterval(framePump);
      try { await conn.cdp.send('Page.stopScreencast', {}, sessionId); } catch { /* session may be gone */ }
      try { ffmpeg.stdin?.end(); } catch { /* process may already be gone */ }
      await new Promise<void>((resolve) => {
        if (ffmpeg.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          try { ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 1000);
        ffmpeg.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await fs.promises.rm(outputPath, { force: true });
      throw error;
    }

    const durationMs = durationSec * 1000;
    const maxBytes = maxMb * 1024 * 1024;

    const state = {
      outputPath,
      startedAt: Date.now(),
      fps,
      durationMs,
      maxBytes,
      ffmpeg,
      ffmpegStderr,
      encoderError: () => stdinError,
      get frameCount() { return frameCount; },
      sessionId,
      conn,
      frameHandler,
      framePump,
      durationTimer: setTimeout(() => {
        this.recordStop(taskId, 'duration-cap').catch(() => {});
      }, durationMs),
      sizeCheckInterval: setInterval(async () => {
        try {
          const st = await fs.promises.stat(outputPath);
          if (st.size >= maxBytes) {
            await this.recordStop(taskId, 'size-cap');
          }
        } catch {
          // File may not exist yet
        }
      }, 1000),
    };
    this.recordings.set(taskId, state);

    return { path: outputPath, fps, durationCapSec: durationSec, maxMb };
  }

  async recordStop(
    taskId: string,
    reason: 'manual' | 'duration-cap' | 'size-cap' = 'manual'
  ): Promise<{ path: string; bytes: number; durationMs: number; reason: string }> {
    const activeTask = await this.findTask(taskId).catch(() => undefined);
    if (activeTask) requireCdp(activeTask.conn, 'recording');
    const rec = this.recordings.get(taskId);
    if (!rec) {
      throw new Error(`Task "${taskId}" is not currently recording`);
    }
    if (rec.stopReason) {
      // Already stopping (e.g. size-cap fired while user also called stop).
      // Wait for in-flight finalize.
      while (this.recordings.has(taskId)) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    rec.stopReason = reason;

    clearTimeout(rec.durationTimer);
    clearInterval(rec.sizeCheckInterval);
    clearInterval(rec.framePump);
    rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler);

    try {
      await rec.conn.cdp.send('Page.stopScreencast', {}, rec.sessionId);
    } catch {
      // session may already be gone
    }

    // Close ffmpeg stdin so it flushes the output file cleanly, and observe how
    // it exits. A non-zero exit means the encode failed — the recording must
    // NOT be reported as success. If ffmpeg hangs, KILL it (don't just abandon
    // the promise, which leaked the process) and treat the recording as failed.
    const finalize = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      let done = false;
      const settle = (r: { code: number | null; timedOut: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
        settle({ code: null, timedOut: true });
      }, 5000);
      rec.ffmpeg.once('exit', (code) => settle({ code, timedOut: false }));
      try {
        rec.ffmpeg.stdin?.end();
      } catch {
        // stdin already closed; wait for exit or the hard timeout above.
      }
    });

    const durationMs = Date.now() - rec.startedAt;
    // Drop the recording from the map before any throw, so a failed stop
    // doesn't wedge the task in a permanent "already recording" state.
    this.recordings.delete(taskId);

    if (finalize.timedOut) {
      throw new Error(
        `ffmpeg did not exit within 5s while finalizing the recording; killed it. ` +
          `The recording at ${rec.outputPath} is incomplete.`
      );
    }
    if (finalize.code !== 0) {
      const err = rec.ffmpegStderr().trim();
      throw new Error(
        `ffmpeg exited abnormally (code ${finalize.code}) while finalizing the recording at ` +
          `${rec.outputPath}; the file is likely corrupt or empty.` +
          (err ? ` ffmpeg: ${err.slice(-800)}` : '')
      );
    }

    const encoderError = rec.encoderError?.();
    if (encoderError) {
      throw new Error(
        `ffmpeg stopped accepting recording frames at ${rec.outputPath}: ${encoderError.message}`
      );
    }

    if (rec.frameCount === 0) {
      throw new Error(`Chrome delivered no frames for the recording at ${rec.outputPath}; the output is empty.`);
    }

    let bytes = 0;
    try {
      const st = await fs.promises.stat(rec.outputPath);
      bytes = st.size;
    } catch {
      // ffmpeg exited 0 but the file is missing — still a failed recording.
    }
    return { path: rec.outputPath, bytes, durationMs, reason };
  }

  async recordStatus(taskId: string): Promise<{ recording: boolean; path?: string; elapsedMs?: number }> {
    // Do not refresh task activity during idle checks; unsupported recording backends report not
    // recording.
    const live = this.findTaskByHandle(taskId) ?? await this.findTask(taskId).catch(() => undefined);
    if (live && (live.conn.backend === 'arc-native' || live.conn.backend === 'bidi')) return { recording: false };
    const rec = this.recordings.get(taskId);
    if (!rec) return { recording: false };
    return { recording: true, path: rec.outputPath, elapsedMs: Date.now() - rec.startedAt };
  }

  async refs(
    taskId: string,
    tabHint?: string,
    opts: RefOpts = {}
  ): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      const result = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(opts)),
        opts,
      );
      this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
      this.saveTaskStateSoon(task.profile, conn.tasks);
      return result;
    }
    // Firefox BiDi: the same DOM-derived accessibility listing Arc
    // uses, evaluated over BiDi. selector-based refs, no CDP accessibility tree.
    if (conn.backend === 'bidi') {
      const result = parseArcRefsResult(
        await this.evaluateFirefox(conn, task, shortId, arcRefsExpression(opts)),
        opts,
      );
      this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
      this.saveTaskStateSoon(task.profile, conn.tasks);
      return result;
    }
    requireCdp(conn, 'enumerate');
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const result = await getRefs(conn.cdp, sessionId, opts);
    // Only refs() updates cached descriptors and numbering options; actions read them. Persist them
    // across daemon restarts.
    this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
    this.saveTaskStateSoon(task.profile, conn.tasks);
    return { refs: result.refs, nodeMap: result.nodeMap };
  }

  /** Record the last ref listing (descriptors + opts) for a tab into state. */
  private cacheRefDescriptors(
    task: Task,
    shortId: string,
    nodeMap: Map<number, RefNode>,
    opts: { interactive: boolean; limit: number }
  ): void {
    if (!task.refDescriptors) task.refDescriptors = {};
    task.refDescriptors[shortId] = { descriptors: describeRefs(nodeMap), opts };
    let perTab = this.refNodes.get(task);
    if (!perTab) this.refNodes.set(task, (perTab = new Map()));
    perTab.set(shortId, nodeMap);
  }

  /** Return a cached node only while its identity still matches the listing; uncertainty triggers
   * rebuild and healing. */
  private async cachedRefIfCurrent(
    conn: CdpProfileConnection,
    sessionId: string,
    task: Task,
    shortId: string,
    ref: number
  ): Promise<{ node: RefNode; renamed?: HealInfo } | undefined> {
    const node = this.refNodes.get(task)?.get(shortId)?.get(ref);
    if (!node) return undefined;
    const name = await refStillMatches(conn.cdp, sessionId, node);
    if (name === undefined) return undefined;
    return name === node.name
      ? { node }
      : { node, renamed: { from: ref, to: ref, role: node.role, name: node.name, renamed: name } };
  }

  /** Heal a drifted positional ref against cached descriptors; return the resolved ref and heal
   * details, or throw if gone. */
  private resolveHealedRef(
    snapshot: RefSnapshot | undefined,
    nodeMap: Map<number, RefNode>,
    ref: number
  ): { targetRef: number; healed?: HealInfo } {
    const cached = snapshot?.descriptors.find((d) => d.ref === ref);
    if (!cached) return { targetRef: ref };

    const fresh = nodeMap.get(ref);
    const stillMatches =
      fresh !== undefined &&
      fresh.role === cached.role &&
      fresh.name === cached.name &&
      fresh.frame === cached.frame &&
      (fresh.backendNodeId !== undefined || fresh.selector !== undefined);
    if (stillMatches) return { targetRef: ref };

    const newRef = healRef(cached, nodeMap);
    if (newRef === null) {
      throw new Error(
        `Ref ${ref} (${cached.role} "${cached.name}") could not be re-resolved: ` +
          `no matching element on the current page. Re-run 'browser refs' to ` +
          `refresh the ref numbers, or act by position with 'browser click --at X,Y'.`
      );
    }
    if (newRef === ref) return { targetRef: ref };

    emit('browser.ref_healed', { from: ref, to: newRef, role: cached.role, name: cached.name.slice(0, 40) });
    return { targetRef: newRef, healed: { from: ref, to: newRef, role: cached.role, name: cached.name } };
  }

  async click(
    taskId: string,
    ref: number,
    tabHint?: string,
    opts: ActionOpts = {},
  ): Promise<{ healed?: HealInfo; snapshot?: PageSnapshot; chose?: string; asking?: string; note?: string }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      await this.evaluateArcNative(conn, task, shortId, arcClickExpression(selector));
      return this.withSnapshot(healed ? { healed } : {}, conn, task, shortId, opts);
    }
    if (conn.backend === 'bidi') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateFirefox(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      const coords = await this.firefoxRefCoords(conn, task, shortId, selector);
      const context = this.firefoxContext(task, shortId);
      await bidiClickAt(conn.bidi, context, coords.x, coords.y);
      return this.withSnapshot(healed ? { healed } : {}, conn, task, shortId, opts);
    }
    requireCdp(conn, 'click');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    const finish = async (healed?: HealInfo, chose?: string): Promise<{ healed?: HealInfo; snapshot?: PageSnapshot; chose?: string }> => {
      const extra = { ...(healed ? { healed } : {}), ...(chose !== undefined ? { chose } : {}) };
      return { ...extra, ...(await this.settled(settle, opts, conn, task, shortId)) };
    };
    const option = async (node: RefNode | undefined): Promise<string | undefined> =>
      node?.role === 'option' && node.backendNodeId !== undefined
        ? chooseNativeOption(conn.cdp, node.sessionId ?? sessionId, node.backendNodeId)
        : undefined;
    try {
      const current = await this.cachedRefIfCurrent(conn, sessionId, task, shortId, ref);
      if (current) {
        const chose = await option(current.node);
        if (chose !== undefined) return await finish(current.renamed, chose);
        const { asking, note } = await this.clickNode(conn, sessionId, current.node);
        if (asking) return { asking };
        // Awaited so `finally` disposes the settle only after it settles: an
        // unawaited return unhooked its listeners mid-wait, and every
        // same-document click sat out the 3 s load timeout.
        return { ...(await finish(current.renamed)), ...(note ? { note } : {}) };
      }
      // Rebuild with the cached listing's options so ref numbers match what the caller saw.
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);

      // Resolve drift against cached descriptors before clicking; actions must not renumber the
      // caller's refs cache.
      const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);

      const chose = await option(nodeMap.get(targetRef));
      if (chose !== undefined) return await finish(healed, chose);
      const node = nodeMap.get(targetRef);
      if (!node) throw new Error(`Ref ${targetRef} not found`);
      const { asking, note } = await this.clickNode(conn, sessionId, node);
      if (asking) return { ...(healed ? { healed } : {}), asking };
      return { ...(await finish(healed)), ...(note ? { note } : {}) };
    } finally {
      settle?.dispose();
    }
  }

  private async clickNode(conn: CdpProfileConnection, sessionId: string, node: RefNode): Promise<{ asking?: string; note?: string }> {
    const at = await resolveRefToCoords(conn.cdp, sessionId, new Map([[node.ref, node]]), node.ref);
    const id = node.backendNodeId!;
    const label = `${node.role}${node.name ? ` "${node.name}"` : ''}`;
    const inDom = async (why: string): Promise<{ asking?: string; note: string }> => {
      let enabled = true;
      const asking = await this.raceDialog(at.sessionId, clickInDom(conn.cdp, at.sessionId, id).then((ok) => { enabled = ok; }));
      if (!enabled) throw new Error(`${label} is disabled; nothing was clicked.`);
      return { ...(asking ? { asking } : {}), note: `${why}, so it was clicked through the DOM` };
    };
    const cover = await coverAt(conn.cdp, at.sessionId, id, at.x, at.y);
    if (cover) return inDom(`${cover} covers ${label}`);
    const landed = await armClickProbe(conn.cdp, at.sessionId, id);
    if (!landed) throw new Error(`${label} is disabled; nothing was clicked.`);
    let asking: string | undefined;
    try {
      asking = await this.raceDialog(at.sessionId, clickAtCoords(conn.cdp, at.sessionId, at.x, at.y));
    } catch (error) {
      void landed();
      throw error;
    }
    if (asking) {
      void landed();
      return { asking };
    }
    return (await landed()) ? {} : { note: `the click may not have reached ${label}; check the page` };
  }

  /** Click viewport coordinates when screenshot-visible targets have no usable accessibility ref. */
  async clickAt(
    taskId: string,
    x: number,
    y: number,
    tabHint?: string,
    opts: ActionOpts = {},
  ): Promise<{ snapshot?: PageSnapshot; asking?: string }> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    try {
      const asking = await this.raceDialog(sessionId, clickAtCoords(conn.cdp, sessionId, x, y));
      if (asking) return { asking };
      return this.settled(settle, opts, conn, task, shortId);
    } finally {
      settle?.dispose();
    }
  }

  /** Arm the load wait before navigation/reload so it cannot mistake the old document for the new one. */
  private async loadSettled(
    conn: CdpProfileConnection,
    sessionId: string,
    opts: ActionOpts,
    go: () => Promise<unknown>,
  ): Promise<void> {
    if (!opts.snapshot && !opts.wait) {
      await go();
      return;
    }
    const settle = await this.armSettle(conn, sessionId);
    try {
      const { loaderId } = ((await go()) ?? {}) as { loaderId?: string };
      await settle.waitForLoad(loaderId);
    } finally {
      settle.dispose();
    }
  }

  /** After an action: settle (`--wait`, `--snapshot`), and for `--snapshot` list the page. */
  private async settled(
    settle: SettleHandle | undefined,
    opts: ActionOpts,
    conn: ProfileConnection,
    task: Task,
    shortId: string,
  ): Promise<{ snapshot?: PageSnapshot }> {
    if (!settle) return {};
    await settle.waitForActionToSettle();
    return opts.snapshot ? { snapshot: await this.snapshotPage(conn, task, shortId, { settled: true }) } : {};
  }

  /** Attach the current snapshot without a settle wait on backends lacking page lifecycle events. */
  private async withSnapshot<T extends object>(
    result: T,
    conn: ProfileConnection,
    task: Task,
    shortId: string,
    opts: ActionOpts,
  ): Promise<T & { snapshot?: PageSnapshot }> {
    if (!opts.snapshot) return result;
    return { ...result, snapshot: await this.snapshotPage(conn, task, shortId) };
  }

  async type(
    taskId: string,
    ref: number | string,
    text: string,
    tabHint?: string,
    clear?: boolean,
    opts: ActionOpts & { secretSite?: string } = {},
  ): Promise<{ snapshot?: PageSnapshot; reads?: string }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const site = opts.secretSite;
    if (conn.backend === 'arc-native') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      if (typeof ref === 'string') throw new Error(NAMED_TARGET_NEEDS_CDP);
      const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      if (site) assertSecretSite(site, String(await this.evaluateArcNative(conn, task, shortId, 'location.origin')));
      await this.evaluateArcNative(conn, task, shortId, arcFillExpression(selector, text, clear ?? false));
      return this.withSnapshot({}, conn, task, shortId, opts);
    }
    if (conn.backend === 'bidi') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateFirefox(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      if (typeof ref === 'string') throw new Error(NAMED_TARGET_NEEDS_CDP);
      const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      if (site) assertSecretSite(site, String(await this.evaluateFirefox(conn, task, shortId, 'location.origin')));
      await this.evaluateFirefox(conn, task, shortId, arcFillExpression(selector, text, clear ?? false));
      return this.withSnapshot({}, conn, task, shortId, opts);
    }
    requireCdp(conn, 'type');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    try {
      const node = await this.cdpRefNode(conn, sessionId, task, shortId, ref, { roles: TYPE_ROLES, opts, typing: true });
      if (site) assertSecretSite(site, await nodeOrigin(conn.cdp, node.sessionId ?? sessionId, node.backendNodeId));
      let reads: string | undefined;
      if (node.editor) {
        await typeEditorText(conn.cdp, sessionId, node, text, clear);
      } else {
        const valueInput = node.backendNodeId
          ? await typeIntoValueInput(conn.cdp, node.sessionId ?? sessionId, node.backendNodeId, text)
          : undefined;
        if (valueInput) {
          reads = valueInput.reads;
        } else {
          if (node.backendNodeId) {
            await focusNode(conn.cdp, node.sessionId ?? sessionId, node.backendNodeId);
          }
          await typeText(conn.cdp, node.sessionId ?? sessionId, text);
        }
      }
      return { reads, ...(await this.settled(settle, opts, conn, task, shortId)) };
    } finally {
      settle?.dispose();
    }
  }

  /** Click by accessible name, exact before substring, without changing the caller's cached ref
   * numbering. */
  async clickByName(
    taskId: string,
    name: string,
    role: string | undefined,
    tabHint?: string,
    opts: ActionOpts = {},
  ): Promise<{ clicked: string; matches: number; snapshot?: PageSnapshot; asking?: string; note?: string }> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'click --text');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const target = await this.getTarget(conn, this.getCdpTargetId(task, shortId));
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);
    if (!name.trim()) throw new Error('--text needs the name of the element to click, e.g. --text "Checkout".');
    const { node, matches } = await this.nodeByName(conn, sessionId, name, role ? [role.toLowerCase()] : undefined, opts);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    try {
      const clicked = `${node.role} "${node.name}"`;
      const { asking, note } = await this.clickNode(conn, sessionId, node);
      if (asking) return { clicked, matches, asking };
      return { clicked, matches, ...(note ? { note } : {}), ...(await this.settled(settle, opts, conn, task, shortId)) };
    } finally {
      settle?.dispose();
    }
  }

  /** Find by accessible name and optional roles, retrying until load timeout; no-wait checks once. */
  private async nodeByName(
    conn: CdpProfileConnection,
    sessionId: string,
    name: string,
    roles: string[] | undefined,
    opts: ActionOpts,
    typing = false,
  ): Promise<{ node: RefNode; matches: number }> {
    const label = (text: string) => plainSpaces(text).trim().toLowerCase();
    const wanted = label(name);
    // An empty shell variable must not pick the first field on the page.
    if (!wanted) throw new Error('Name the element, e.g. "Email" or "Checkout".');
    // A native <select> is a combobox too, but typing into it only jumps by first letters.
    const takesText = async (n: RefNode) => {
      if (!typing || n.role !== 'combobox') return true;
      const described = await conn.cdp
        .send<{ node: { nodeName: string } }>('DOM.describeNode', { backendNodeId: n.backendNodeId }, n.sessionId ?? sessionId)
        .catch(() => undefined);
      return described?.node.nodeName !== 'SELECT';
    };
    const deadline = opts.wait === false ? 0 : Date.now() + BrowserService.SNAPSHOT_LOAD_TIMEOUT_MS;
    let candidates: RefNode[];
    let matches: RefNode[];
    for (;;) {
      const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: true, limit: 500 });
      candidates = [];
      for (const n of nodeMap.values()) {
        if ((!roles || roles.includes(n.role)) && n.backendNodeId !== undefined && (await takesText(n))) candidates.push(n);
      }
      const exact = candidates.filter((n) => label(n.name) === wanted);
      matches = exact.length > 0 ? exact : candidates.filter((n) => label(n.name).includes(wanted));
      if (matches.length > 0 || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (matches.length === 0) {
      const names = [...new Set(candidates.map((n) => `${n.role} "${n.name}"`).filter((s) => !s.endsWith('""')))].slice(0, 12);
      throw new Error(
        `No ${roles?.join(' or ') ?? 'element'} named "${name}" on this page.` +
          (names.length ? ` Elements here: ${names.join(', ')}` : ''),
      );
    }
    return { node: matches[0]!, matches: matches.length };
  }

  /** Resolve a CDP ref from a validated cache or rebuild with the original listing options and heal
   * drift. */
  private async cdpRefNode(
    conn: CdpProfileConnection,
    sessionId: string,
    task: Task,
    shortId: string,
    ref: number | string,
    named?: { roles: string[]; opts: ActionOpts; typing?: boolean },
  ): Promise<RefNode> {
    if (typeof ref === 'string') return (await this.nodeByName(conn, sessionId, ref, named?.roles, named?.opts ?? {}, named?.typing)).node;
    const current = await this.cachedRefIfCurrent(conn, sessionId, task, shortId, ref);
    if (current) return current.node;
    const snapshot = task.refDescriptors?.[shortId];
    const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
    const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);
    const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
    const node = nodeMap.get(targetRef);
    if (!node) throw new Error(`Ref ${ref} not found`);
    return node;
  }

  /** `browser select`: pick an option of a native <select> by value or label; returns the label chosen. */
  async select(
    taskId: string,
    ref: number | string,
    option: string,
    tabHint?: string,
    opts: ActionOpts = {},
  ): Promise<{ selected: string; snapshot?: PageSnapshot }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native' || conn.backend === 'bidi') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const listing = arcRefsExpression(buildOpts);
      const { nodeMap } = parseArcRefsResult(
        conn.backend === 'bidi'
          ? await this.evaluateFirefox(conn, task, shortId, listing)
          : await this.evaluateArcNative(conn, task, shortId, listing),
        buildOpts,
      );
      if (typeof ref === 'string') throw new Error(NAMED_TARGET_NEEDS_CDP);
      const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      const expression = arcSelectExpression(selector, option);
      const selected = String(
        conn.backend === 'bidi'
          ? await this.evaluateFirefox(conn, task, shortId, expression)
          : await this.evaluateArcNative(conn, task, shortId, expression),
      );
      return this.withSnapshot({ selected }, conn, task, shortId, opts);
    }
    requireCdp(conn, 'select');
    const target = await this.getTarget(conn, this.getCdpTargetId(task, shortId));
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    try {
      const node = await this.cdpRefNode(conn, sessionId, task, shortId, ref, { roles: SELECT_ROLES, opts });
      if (!node.backendNodeId) throw new Error(`Ref ${ref} has no DOM node`);
      const nodeSession = node.sessionId ?? sessionId;
      const { object } = (await conn.cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, nodeSession)) as {
        object: { objectId?: string };
      };
      if (!object.objectId) throw new Error(`Ref ${ref} has no DOM node`);
      try {
        const { result, exceptionDetails } = (await conn.cdp.send(
          'Runtime.callFunctionOn',
          { objectId: object.objectId, functionDeclaration: SELECT_OPTION_FN, arguments: [{ value: option }], returnByValue: true },
          nodeSession,
        )) as { result: { value?: string }; exceptionDetails?: { exception?: { description?: string } } };
        if (exceptionDetails) throw new Error((exceptionDetails.exception?.description ?? 'select failed').split('\n')[0].replace(/^Error: /, ''));
        const selected = String(result.value ?? option);
        return { selected, ...(await this.settled(settle, opts, conn, task, shortId)) };
      } finally {
        await conn.cdp.send('Runtime.releaseObject', { objectId: object.objectId }, nodeSession).catch(() => {});
      }
    } finally {
      settle?.dispose();
    }
  }

  async press(
    taskId: string,
    key: string,
    tabHint?: string,
    opts: ActionOpts = {},
  ): Promise<{ snapshot?: PageSnapshot; asking?: string }> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const settle = opts.snapshot || opts.wait ? await this.armSettle(conn, sessionId) : undefined;
    try {
      const asking = await this.raceDialog(sessionId, pressKey(conn.cdp, sessionId, key));
      if (asking) return { asking };
      return this.settled(settle, opts, conn, task, shortId);
    } finally {
      settle?.dispose();
    }
  }

  async hover(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Same numbering and healing as click: the refs the caller saw in `browser refs`.
    const node = await this.cdpRefNode(conn, sessionId, task, shortId, ref);
    const at = await resolveRefToCoords(conn.cdp, sessionId, new Map([[node.ref, node]]), node.ref);
    await hoverAtCoords(conn.cdp, at.sessionId, at.x, at.y);
  }

  async scroll(
    taskId: string,
    deltaX: number,
    deltaY: number,
    atX?: number,
    atY?: number,
    tabHint?: string
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      if (atX !== undefined || atY !== undefined) throw new ArcNativeCapabilityError('trustedInput');
      await this.evaluateArcNative(conn, task, shortId, arcScrollExpression(deltaX, deltaY));
      return;
    }
    if (conn.backend === 'bidi') {
      await this.evaluateFirefox(conn, task, shortId, arcScrollExpression(deltaX, deltaY));
      return;
    }
    requireCdp(conn, 'scroll');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await scrollAtCoords(conn.cdp, sessionId, atX ?? 0, atY ?? 0, deltaX, deltaY);
  }

  async upload(
    taskId: string,
    files: string[],
    options: {
      ref?: number;
      trigger?: number;
      mode?: UploadMode;
      tabHint?: string;
      timeout?: number;
    }
  ): Promise<{ mode: 'input' | 'drop' | 'chooser' }> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'upload');
    const shortId = options.tabHint
      ? await this.resolveTabHint(conn, task, options.tabHint)
      : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Use the interactive numbering the caller saw in refs, rather than renumbering against the full
    // tree.
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: true, limit: 1000 });

    const mode = options.mode ?? 'auto';

    if (options.trigger !== undefined || mode === 'chooser') {
      const ref = options.trigger ?? options.ref;
      if (ref === undefined) {
        throw new Error('chooser mode requires --trigger <ref> (or --ref) pointing at the button that opens the file dialog');
      }
      const node = nodeMap.get(ref);
      if (!node) throw new Error(`Ref ${ref} not found`);
      refuseCrossSiteUpload(node, ref);
      await uploadViaFileChooser(
        conn.cdp,
        sessionId,
        { node, nodeMap },
        files,
        options.timeout
      );
      return { mode: 'chooser' };
    }

    if (options.ref === undefined) {
      throw new Error('upload requires --ref <n> (target element) or --trigger <n> (button that opens chooser)');
    }
    const node = nodeMap.get(options.ref);
    if (!node) throw new Error(`Ref ${options.ref} not found`);
    if (!node.backendNodeId) throw new Error(`Ref ${options.ref} has no DOM node`);
    refuseCrossSiteUpload(node, options.ref);

    let resolved: 'input' | 'drop';
    if (mode === 'input') {
      resolved = 'input';
    } else if (mode === 'drop') {
      resolved = 'drop';
    } else {
      resolved = await detectUploadPattern(conn.cdp, sessionId, node.backendNodeId);
    }

    if (resolved === 'input') {
      await uploadToFileInput(conn.cdp, sessionId, node.backendNodeId, files);
    } else {
      await uploadToDropTarget(conn.cdp, sessionId, node.backendNodeId, files);
    }
    return { mode: resolved };
  }

  stageUpload(source: string): { path: string } {
    return { path: stageUploadFile(source) };
  }

  /** Return status for a bare profile name or all live profiles, falling back to disk when no live
   * connection matches. */
  async status(profileRef?: ProfileName | ConnectionKey): Promise<ProfileStatus[]> {
    // Built before rehydration: a cold pass rehydrates every saved runtime dir
    // first, and each Arc one probed Arc on its own, spending the budget before
    // the snapshot existed. One enumeration and one liveness read cover the pass.
    const arc: ArcStatusReaders = {
      spaces: onceAsync(() => enumerateArcSpaces()),
      running: onceAsync(() => isArcRunning()),
    };

    // Reconnect live browsers after a daemon restart so status is not empty
    // while tasks.json still holds open work. Rehydration is per runtime dir:
    // one unreadable saved profile is reported below, never fatal to the pass.
    const rehydrateErrors = new Map<ConnectionKey, string>();
    await this.rehydrateAllFromDisk(arc.running, (key, err) => {
      rehydrateErrors.set(key, err instanceof Error ? err.message : String(err));
    });

    // A caller who pasted a runtime key out of an older listing still gets the
    // profile it belongs to, rather than an empty result.
    const profileName = profileRef ? parseConnectionKey(profileRef).profile : undefined;

    const seenProfiles = new Set<ProfileName>();
    const statuses: ProfileStatus[] = [];

    const candidates = profileName
      ? [...this.connections.keys()].filter((k) => keyBelongsToProfile(k, profileName))
      : Array.from(this.connections.keys());

    for (const key of candidates) {
      // Read-only: a profile that cannot be read is reported as unreadable, not
      // allowed to abort the listing. Before this, a single stale Arc task made
      // `status` throw and EVERY profile vanished, including healthy ones.
      let status: ProfileStatus | null;
      try {
        status = await this.getProfileStatus(key, arc);
      } catch (err) {
        const parsed = parseConnectionKey(key);
        statuses.push({
          name: this.connections.get(key)?.profile ?? parsed.profile,
          endpoint: parsed.endpoint,
          key,
          running: false,
          tasks: [],
          unavailable: err instanceof Error ? err.message : String(err),
        });
        seenProfiles.add(parsed.profile);
        continue;
      }
      if (status) {
        statuses.push(status);
        seenProfiles.add(status.name);
      }
    }

    // Reported BEFORE the disk reconcile, and keyed by the runtime dir that
    // actually failed. Reconcile reads the same `tasks.json`, so without this
    // ordering one corrupt runtime produced two rows for the same profile: one
    // keyed here and one unkeyed from reconcile, which the dedupe then missed.
    for (const [key, message] of rehydrateErrors) {
      const parsed = parseConnectionKey(key);
      if (profileName && parsed.profile !== profileName) continue;
      if (statuses.some((status) => status.key === key)) continue;
      statuses.push({
        name: parsed.profile,
        endpoint: parsed.endpoint,
        key,
        running: false,
        tasks: [],
        unavailable: message,
      });
      seenProfiles.add(parsed.profile);
    }

    // Disk reconcile reads `tasks.json` too, so it fails on exactly the same
    // corrupt file — report that profile rather than let it empty the table.
    const reconcile = async (name: ProfileName): Promise<void> => {
      const failures = new Map<ConnectionKey, string>();
      let reconciled: ProfileStatus | null = null;
      try {
        reconciled = await this.reconcileFromDisk(name, (key, err) => {
          failures.set(key, err instanceof Error ? err.message : String(err));
        });
      } catch (err) {
        // Listing the profile's runtime dirs failed, so no single runtime is at
        // fault and none is invented: this is reported at profile level.
        statuses.push({
          name,
          running: false,
          tasks: [],
          unavailable: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (reconciled) statuses.push(reconciled);
      // Keyed by the runtime dir that actually failed, so a profile with several
      // runtimes names the unreadable one rather than guessing at the first.
      for (const [key, message] of failures) {
        if (statuses.some((status) => status.key === key)) continue;
        const parsed = parseConnectionKey(key);
        statuses.push({
          name,
          endpoint: parsed.endpoint,
          key,
          running: false,
          tasks: [],
          unavailable: message,
        });
      }
    };

    if (!profileName) {
      for (const profile of await listProfiles()) {
        if (seenProfiles.has(profile.name)) continue;
        await reconcile(profile.name);
      }
    } else if (statuses.length === 0) {
      await reconcile(profileName);
    }

    return statuses;
  }

  /** Rebuild status from every runtime directory belonging to a bare profile name, including legacy
   * directories. */
  private async reconcileFromDisk(
    profileName: ProfileName,
    /** A supplied error sink keeps unreadable runtime directories from aborting read-only listings;
     * otherwise throw. */
    onError?: (key: ConnectionKey, error: unknown) => void,
  ): Promise<ProfileStatus | null> {
    const dirs = listProfileCacheDirs(profileName);
    for (const dir of dirs) {
      const key = asConnectionKey(path.basename(dir));
      try {
        const info = getRunningChromeInfo(key);
        if (!info) continue;
        return await this.profileStatusFromDisk(profileName, key, info.port, info.pid);
      } catch (err) {
        if (!onError) throw err;
        onError(key, err);
      }
    }
    return null;
  }

  private async profileStatusFromDisk(
    profileName: ProfileName,
    runtimeKey: ConnectionKey,
    port: number,
    pid: number,
  ): Promise<ProfileStatus> {
    const profile = await getProfile(profileName);
    const tasks = this.loadTaskState(runtimeKey);
    const taskStatuses: TaskStatus[] = [];
    for (const [, task] of tasks) {
      taskStatuses.push({
        id: task.id,
        name: task.name,
        label: task.label ?? task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
      });
    }
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;
    return {
      // Bare name for the user; the endpoint travels in its own field.
      name: profileName,
      endpoint: parseConnectionKey(runtimeKey).endpoint,
      key: runtimeKey,
      running: true,
      port,
      pid,
      configuredPort: configuredPort !== port ? configuredPort : undefined,
      tasks: taskStatuses,
    };
  }

  // ─── Viewport & Device Emulation ──────────────────────────────────────────────

  async setViewport(
    taskId: string,
    width: number,
    height: number,
    options: { mobile?: boolean; deviceScaleFactor?: number; tabHint?: string } = {}
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'viewport');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    await conn.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        mobile: options.mobile ?? false,
      },
      sessionId
    );
  }

  async setDevice(taskId: string, deviceName: string, tabHint?: string): Promise<void> {
    const { getDevice } = await import('./devices.js');
    const device = getDevice(deviceName);
    if (!device) {
      const { listDevices } = await import('./devices.js');
      throw new Error(`Unknown device "${deviceName}". Available: ${listDevices().join(', ')}`);
    }
    await this.setViewport(taskId, device.width, device.height, {
      mobile: device.mobile,
      deviceScaleFactor: device.deviceScaleFactor,
      tabHint,
    });
  }

  // ─── Console & Errors ────────────────────────────────────────────────────────

  /** Subscribe before the action to observe its navigation; bound the wait so snapshots can describe
   * stalled pages. */
  private async armSettle(conn: CdpProfileConnection, sessionId: string): Promise<SettleHandle> {
    await this.enablePageForSession(conn, sessionId);
    if (!this.enabledSessions.get(sessionId)?.has('Page.lifecycle')) {
      await conn.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
      this.enabledSessions.get(sessionId)!.add('Page.lifecycle');
    }
    // Only the top frame's navigations count. Ad and live-example iframes
    // navigate on their own schedule (and on a keystroke), and their `init`
    // without a matching `load` inside the window made a same-page type wait
    // out the whole load timeout.
    const { frameTree } = (await conn.cdp.send('Page.getFrameTree', {}, sessionId)) as {
      frameTree: { frame: { id: string } };
    };
    const mainFrameId = frameTree.frame.id;
    const started = new Set<string>();
    const loaded = new Set<string>();
    // A navigation is known the moment the top frame starts loading, which is
    // synchronous with the click or Enter that caused it; the lifecycle `init`
    // only arrives once the new document commits, a network round trip later.
    let navigationBegan = false;
    // A router's pushState (GitHub, most SPAs) starts loading in the top frame
    // but never produces a `load`; its own signal is `navigatedWithinDocument`.
    let sameDocument = false;
    // Only a history-API navigation is a router that renders afterwards; an
    // `#anchor` jump changes the URL and nothing else.
    let routed = false;
    const onStartedLoading = (params: Record<string, unknown>, sid?: string) => {
      if (sid === sessionId && (params as { frameId: string }).frameId === mainFrameId) navigationBegan = true;
    };
    const onWithinDocument = (params: Record<string, unknown>, sid?: string) => {
      const { frameId, navigationType } = params as { frameId: string; navigationType?: string };
      if (sid !== sessionId || frameId !== mainFrameId) return;
      sameDocument = true;
      if (navigationType === 'historyApi') routed = true;
    };
    const handler = (params: Record<string, unknown>, sid?: string) => {
      if (sid !== sessionId) return;
      const { name, loaderId, frameId } = params as { name: string; loaderId: string; frameId: string };
      if (frameId !== mainFrameId) return;
      if (name === 'init') { started.add(loaderId); navigationBegan = true; }
      if (name === 'load') loaded.add(loaderId);
    };
    conn.cdp.on('Page.frameStartedLoading', onStartedLoading);
    conn.cdp.on('Page.navigatedWithinDocument', onWithinDocument);
    conn.cdp.on('Page.lifecycleEvent', handler);
    // A same-document update usually fetches first and renders later (a router
    // link, a filtered list), so "nothing navigated" is not "nothing happened":
    // count the session's in-flight requests and wait for them to drain.
    if (!this.enabledSessions.get(sessionId)?.has('Network.settle')) {
      await conn.cdp.send('Network.enable', {}, sessionId);
      this.enabledSessions.get(sessionId)!.add('Network.settle');
    }
    const inflight = new Set<string>();
    // Quiet is measured from arm time, so an action that starts nothing pays
    // nothing: only activity seen after the action extends the wait.
    let lastNetworkActivity = 0;
    const onRequest = (params: Record<string, unknown>, sid?: string) => {
      if (sid !== sessionId) return;
      const { requestId, type } = params as { requestId: string; type?: string };
      if (type === 'WebSocket' || type === 'EventSource') return;
      inflight.add(requestId);
      lastNetworkActivity = Date.now();
    };
    const onDone = (params: Record<string, unknown>, sid?: string) => {
      if (sid !== sessionId) return;
      if (inflight.delete((params as { requestId: string }).requestId)) lastNetworkActivity = Date.now();
    };
    conn.cdp.on('Network.requestWillBeSent', onRequest);
    conn.cdp.on('Network.loadingFinished', onDone);
    conn.cdp.on('Network.loadingFailed', onDone);
    const networkIdle = async () => {
      const deadline = Date.now() + BrowserService.SNAPSHOT_DOM_QUIET_CAP_MS;
      while (Date.now() < deadline) {
        if (inflight.size === 0 && (lastNetworkActivity === 0 || Date.now() - lastNetworkActivity >= BrowserService.SNAPSHOT_NETWORK_IDLE_MS)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    // Same for the DOM: an observer installed now records the last mutation,
    // and the settle resolves at once when there was none. A flag mirrors it so
    // the grace window can treat a mutation as "something happened".
    let domMutated = false;
    const token = `__browserSettle${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    try {
      await conn.cdp.send('Runtime.evaluate', {
        expression: `(() => { const s = { last: 0, observer: null }; s.observer = new MutationObserver(() => { s.last = performance.now(); });
          s.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); window[${JSON.stringify(token)}] = s; })()`,
        returnByValue: true,
      }, sessionId);
    } catch {
      // No document to observe (about:blank mid-load); the listing describes whatever loads.
    }
    // Cheap poll so the grace's `domMutated` reflects the in-page observer
    // without a round trip per check; stops itself once the settle is disposed.
    let domPollActive = true;
    const pollDom = async () => {
      while (domPollActive) {
        try {
          const { result } = (await conn.cdp.send('Runtime.evaluate', {
            expression: `!!(window[${JSON.stringify(token)}] && window[${JSON.stringify(token)}].last)`,
            returnByValue: true,
          }, sessionId)) as { result: { value: boolean } };
          if (result.value) { domMutated = true; return; }
        } catch { return; }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    void pollDom();
    // `renderMs`: how long an untouched DOM is still expected to change. A router
    // commits the URL first and renders a frame or more later, so a listing taken
    // the moment the URL changes shows the previous page's elements.
    const domQuiet = async (renderMs = 0) => {
      try {
        await conn.cdp.send('Runtime.evaluate', {
          expression: `new Promise((resolve) => {
            const s = window[${JSON.stringify(token)}];
            if (!s) return resolve('gone');
            const quietMs = ${BrowserService.SNAPSHOT_DOM_QUIET_MS}, capMs = ${BrowserService.SNAPSHOT_DOM_QUIET_CAP_MS}, renderMs = ${renderMs}, t0 = performance.now();
            const finish = (why) => { s.observer.disconnect(); delete window[${JSON.stringify(token)}]; resolve(why); };
            const check = () => {
              if (s.last === 0 ? performance.now() - t0 >= renderMs : performance.now() - s.last >= quietMs) return finish('quiet');
              if (performance.now() - t0 >= capMs) return finish('cap');
              setTimeout(check, 10);
            };
            check();
          })`,
          awaitPromise: true,
          returnByValue: true,
        }, sessionId);
      } catch {
        // A document mid-navigation rejects the evaluate; the listing that follows describes whatever loaded.
      }
    };
    const until = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (!done()) {
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    };
    return {
      // A navigation this handle knows about: wait for its load event, then for
      // the requests that draw the page after it (a shop's product list).
      waitForLoad: async (loaderId?: string) => {
        await until(
          () => (loaderId ? loaded.has(loaderId) : [...started].some((id) => loaded.has(id))),
          BrowserService.SNAPSHOT_LOAD_TIMEOUT_MS,
        );
        await networkIdle();
      },
      // An action that MAY navigate (click, type, Enter): give a navigation a
      // short window to begin; if one did, wait for it to load, else return
      // at once so a same-page interaction pays only the window.
      waitForActionToSettle: async () => {
        // Allow delayed SPA navigation signals before declaring an action inert; inert actions skip
        // settling waits. GitHub-style SPA navigations commit ~70-90 ms after the click, so the grace
        // must outlast that.
        await until(
          () => navigationBegan || inflight.size > 0 || domMutated,
          BrowserService.SNAPSHOT_NAVIGATION_GRACE_MS,
        );
        if (navigationBegan) {
          await until(() => sameDocument || [...started].some((id) => loaded.has(id)), BrowserService.SNAPSHOT_LOAD_TIMEOUT_MS);
          // The old document's observer went with it; the requests are what is left to wait for.
          if (!sameDocument) return networkIdle();
        }
        await networkIdle();
        await domQuiet(routed ? BrowserService.SNAPSHOT_SAME_DOCUMENT_RENDER_MS : 0);
      },
      dispose: () => {
        domPollActive = false;
        conn.cdp.off('Page.frameStartedLoading', onStartedLoading);
        conn.cdp.off('Page.navigatedWithinDocument', onWithinDocument);
        conn.cdp.off('Page.lifecycleEvent', handler);
        conn.cdp.off('Network.requestWillBeSent', onRequest);
        conn.cdp.off('Network.loadingFinished', onDone);
        conn.cdp.off('Network.loadingFailed', onDone);
      },
    };
  }

  /** The tab's url, title and refs once it has finished loading: what `start --snapshot` prints. */
  async snapshot(taskId: string, tabHint?: string): Promise<PageSnapshot> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    return this.snapshotPage(conn, task, shortId);
  }

  /** A new tab, reload or navigation has loaded: no longer the initial blank, and complete. */
  private async waitForDocumentOn(conn: CdpProfileConnection, sessionId: string): Promise<void> {
    const deadline = Date.now() + BrowserService.SNAPSHOT_LOAD_TIMEOUT_MS;
    // A new tab or a reload: the document is ready once it is no longer the
    // initial blank and has finished loading.
    for (;;) {
      const { result } = (await conn.cdp.send(
        'Runtime.evaluate',
        { expression: "document.readyState === 'complete' && location.href !== 'about:blank'", returnByValue: true },
        sessionId,
      )) as { result: { value: boolean } };
      if (result.value || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async waitForDocument(conn: ProfileConnection, task: Task, shortId: string): Promise<void> {
    if (conn.backend !== 'cdp') return;
    const target = await this.getTarget(conn, this.getCdpTargetId(task, shortId));
    if (!target) throw new Error(`Tab ${shortId} not found`);
    await this.waitForDocumentOn(conn, await this.getSessionId(conn, target.targetId));
  }

  /** Return URL, title and interactive refs, caching their numbering; wait for readiness unless already
   * settled. */
  private async snapshotPage(
    conn: ProfileConnection,
    task: Task,
    shortId: string,
    opts: { settled?: boolean } = {},
  ): Promise<PageSnapshot> {
    if (conn.backend !== 'cdp') {
      const { refs } = await this.refs(task.name, shortId);
      const expression = 'JSON.stringify({ url: location.href, title: document.title })';
      const page = conn.backend === 'arc-native'
        ? await this.evaluateArcNative(conn, task, shortId, expression)
        : conn.backend === 'bidi'
          ? await this.evaluateFirefox(conn, task, shortId, expression)
          : undefined;
      const { url, title } = typeof page === 'string' ? (JSON.parse(page) as { url: string; title: string }) : { url: '', title: '' };
      return { url, title, refs };
    }
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);
    if (!opts.settled) await this.waitForDocumentOn(conn, sessionId);
    const { result: page } = (await conn.cdp.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify({ url: location.href, title: document.title })', returnByValue: true },
      sessionId,
    )) as { result: { value: string } };
    const { url, title } = JSON.parse(page.value) as { url: string; title: string };
    const listing = await getRefs(conn.cdp, sessionId, { interactive: true, limit: 500 });
    this.cacheRefDescriptors(task, shortId, listing.nodeMap, listing.opts);
    this.saveTaskStateSoon(task.profile, conn.tasks);
    return { url, title, refs: listing.refs };
  }

  /** `Page.enable` once per session; every Page-domain user goes through here. */
  private async enablePageForSession(conn: CdpProfileConnection, sessionId: string): Promise<void> {
    if (this.enabledSessions.get(sessionId)?.has('Page')) return;
    await conn.cdp.send('Page.enable', {}, sessionId);
    if (!this.enabledSessions.has(sessionId)) this.enabledSessions.set(sessionId, new Set());
    this.enabledSessions.get(sessionId)!.add('Page');
  }

  private async enableRuntimeForSession(conn: CdpProfileConnection, sessionId: string): Promise<void> {
    const key = `${sessionId}:Runtime`;
    if (this.enabledSessions.get(sessionId)?.has('Runtime')) return;

    await conn.cdp.send('Runtime.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Runtime');

    conn.cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const entry: import('./types.js').ConsoleEntry = {
        level: params.type === 'warning' ? 'warn' : params.type,
        text: params.args?.map((a: any) => a.value ?? a.description ?? '').join(' ') || '',
        timestamp: Date.now(),
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      };

      if (!this.consoleLogs.has(taskId)) this.consoleLogs.set(taskId, []);
      const logs = this.consoleLogs.get(taskId)!;
      logs.push(entry);
      if (logs.length > 1000) logs.shift();
    });

    conn.cdp.on('Runtime.exceptionThrown', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const ex = params.exceptionDetails;
      const entry: import('./types.js').ErrorEntry = {
        message: ex.exception?.description || ex.text || 'Unknown error',
        stack: ex.stackTrace?.callFrames?.map((f: any) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber})`).join('\n'),
        timestamp: Date.now(),
        url: ex.url,
        line: ex.lineNumber,
      };

      if (!this.pageErrors.has(taskId)) this.pageErrors.set(taskId, []);
      const errors = this.pageErrors.get(taskId)!;
      errors.push(entry);
      if (errors.length > 500) errors.shift();
    });
  }

  async getConsoleLogs(
    taskId: string,
    options: { level?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ConsoleEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'consoleCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    let logs = this.consoleLogs.get(taskId) || [];
    if (options.level) {
      logs = logs.filter((l) => l.level === options.level);
    }
    if (options.clear) {
      this.consoleLogs.set(taskId, []);
    }
    return logs;
  }

  async getErrors(
    taskId: string,
    options: { clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ErrorEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'consoleCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    const errors = this.pageErrors.get(taskId) || [];
    if (options.clear) {
      this.pageErrors.set(taskId, []);
    }
    return errors;
  }

  // ─── Network Requests ────────────────────────────────────────────────────────

  private async enableNetworkForSession(conn: CdpProfileConnection, sessionId: string, taskId: string): Promise<void> {
    if (this.enabledSessions.get(sessionId)?.has('Network')) return;

    await conn.cdp.send('Network.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Network');

    const requestMap = new Map<string, import('./types.js').NetworkRequest>();

    conn.cdp.on('Network.requestWillBeSent', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req: import('./types.js').NetworkRequest = {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: Date.now(),
      };
      requestMap.set(params.requestId, req);

      if (!this.networkRequests.has(taskId)) this.networkRequests.set(taskId, []);
      const reqs = this.networkRequests.get(taskId)!;
      reqs.push(req);
      if (reqs.length > 500) reqs.shift();
    });

    conn.cdp.on('Network.responseReceived', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req = requestMap.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.mimeType = params.response.mimeType;
      }
    });
  }

  async getNetworkRequests(
    taskId: string,
    options: { filter?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').NetworkRequest[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'networkCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    let requests = this.networkRequests.get(taskId) || [];
    if (options.filter) {
      const f = options.filter.toLowerCase();
      requests = requests.filter((r) => r.url.toLowerCase().includes(f));
    }
    if (options.clear) {
      this.networkRequests.set(taskId, []);
    }
    return requests;
  }

  async getResponseBody(
    taskId: string,
    urlPattern: string,
    options: { timeout?: number; maxChars?: number; tabHint?: string } = {}
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'networkCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    const timeout = options.timeout ?? 30000;
    const maxChars = options.maxChars ?? 200000;
    const start = Date.now();
    const pattern = urlPattern.includes('*')
      ? new RegExp(urlPattern.replace(/\*/g, '.*'), 'i')
      : null;

    while (Date.now() - start < timeout) {
      const requests = this.networkRequests.get(taskId) || [];
      const match = requests.find((r) =>
        pattern ? pattern.test(r.url) : r.url.includes(urlPattern)
      );

      if (match && match.status) {
        try {
          const { body, base64Encoded } = (await conn.cdp.send(
            'Network.getResponseBody',
            { requestId: match.id },
            sessionId
          )) as { body: string; base64Encoded: boolean };

          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
          return text.slice(0, maxChars);
        } catch {
          // Request may have been evicted, continue waiting
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`No response matching "${urlPattern}" within ${timeout}ms`);
  }

  // ─── Wait Conditions ─────────────────────────────────────────────────────────

  async wait(
    taskId: string,
    type: 'time' | 'selector' | 'url' | 'function' | 'load',
    value: string | number,
    options: { timeout?: number; tabHint?: string } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? 30000;
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'asyncEvaluate');

    if (type === 'time') {
      await new Promise((r) => setTimeout(r, typeof value === 'number' ? value : parseInt(value as string, 10)));
      return;
    }

    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const start = Date.now();

    while (Date.now() - start < timeout) {
      let condition = false;

      if (type === 'selector') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!document.querySelector(${JSON.stringify(value)})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'url') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        const pattern = (value as string).includes('*')
          ? new RegExp((value as string).replace(/\*/g, '.*'), 'i')
          : null;
        condition = pattern ? pattern.test(result.result.value) : result.result.value.includes(value as string);
      } else if (type === 'function') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!(${value})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'load') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        if (value === 'domcontentloaded') {
          condition = result.result.value !== 'loading';
        } else if (value === 'load' || value === 'complete') {
          condition = result.result.value === 'complete';
        } else if (value === 'networkidle') {
          // Simplified: check if document is complete
          condition = result.result.value === 'complete';
        }
      }

      if (condition) return;
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(`Wait condition "${type}:${value}" not met within ${timeout}ms`);
  }

  // ─── Downloads ───────────────────────────────────────────────────────────────

  /** Set browser-global downloads on the root session; unsupported Browser domains must not fail
   * connection. */
  private async applyDefaultDownloadBehavior(conn: CdpProfileConnection, key: ConnectionKey): Promise<void> {
    const downloadPath = getProfileDownloadsDir(key);
    try {
      await fs.promises.mkdir(downloadPath, { recursive: true });
      await conn.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath,
        eventsEnabled: true,
      });
    } catch {
      // Best effort: a remote CDP endpoint (ssh://, ws(s)://) may not expose the
      // Browser domain. Downloads then keep the endpoint's own default; the connect
      // must still succeed.
    }
  }

  async setDownloadPath(taskId: string, downloadPath?: string, tabHint?: string): Promise<string> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'download');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    // No explicit --path: fall back to the profile's downloads dir, the same
    // destination already set browser-global at connect (applyDefaultDownloadBehavior).
    const resolvedPath = downloadPath ?? getProfileDownloadsDir(runtimeKey);
    await fs.promises.mkdir(resolvedPath, { recursive: true });

    await conn.cdp.send(
      'Browser.setDownloadBehavior',
      {
        behavior: 'allow',
        downloadPath: resolvedPath,
        eventsEnabled: true,
      },
      sessionId
    );

    this.pendingDownloads.set(taskId, { path: resolvedPath, completed: false });

    conn.cdp.on('Browser.downloadProgress', (params: any) => {
      if (params.state === 'completed') {
        const dl = this.pendingDownloads.get(taskId);
        if (dl) {
          dl.completed = true;
          dl.filename = params.suggestedFilename;
        }
      }
    });

    return resolvedPath;
  }

  async waitForDownload(taskId: string, timeout: number = 60000): Promise<string> {
    const { conn } = await this.findTask(taskId);
    requireCdp(conn, 'download');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const dl = this.pendingDownloads.get(taskId);
      if (dl?.completed) {
        const fullPath = dl.filename ? `${dl.path}/${dl.filename}` : dl.path;
        this.pendingDownloads.delete(taskId);
        return fullPath;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Download not completed within ${timeout}ms`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private findTaskBySession(conn: ProfileConnection, sessionId: string): string | undefined {
    for (const [taskId, task] of conn.tasks) {
      for (const tabId of Object.values(task.tabs)) {
        if (conn.sessionCache.get(tabId) === sessionId) {
          return taskId;
        }
      }
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    // Drain any in-flight recordings first so we don't orphan ffmpeg processes
    // or leak the duration/size-check timers when the daemon goes down.
    for (const [taskId, rec] of this.recordings) {
      clearTimeout(rec.durationTimer);
      clearInterval(rec.sizeCheckInterval);
      try { rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler); } catch { /* socket may be gone */ }
      clearInterval(rec.framePump);
      try { rec.ffmpeg.stdin?.end(); } catch { /* already closed */ }
      // Give ffmpeg up to 1s to flush; then SIGKILL.
      const exited = await new Promise<boolean>((resolve) => {
        let done = false;
        rec.ffmpeg.once('exit', () => { done = true; resolve(true); });
        setTimeout(() => { if (!done) resolve(false); }, 1000);
      });
      if (!exited) {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
      }
      this.recordings.delete(taskId);
    }

    for (const [, conn] of this.connections) {
      if (conn.backend === 'bidi') conn.bidi.close();
      else if (conn.backend !== 'arc-native') conn.cdp.close();
      conn.cleanup?.();
    }
    this.connections.clear();
  }

  private findAvailableFork(
    baseKey: ConnectionKey
  ): { name: ConnectionKey; conn: ProfileConnection } | null {
    for (const [name, conn] of this.connections) {
      if (conn.forkedFrom === baseKey && conn.tasks.size === 0) {
        return { name, conn };
      }
    }
    return null;
  }

  private async forkElectronProfile(
    profile: BrowserProfile,
    baseKey: ConnectionKey,
  ): Promise<{ forkName: ConnectionKey; connection: ProfileConnection }> {
    let forkNum = 2;
    while (this.connections.has(asConnectionKey(`${baseKey}.${forkNum}`))) {
      forkNum++;
    }
    const forkName = asConnectionKey(`${baseKey}.${forkNum}`);

    const port = allocatePort();
    const chromeOpts = { ...profile.chrome, viewport: profile.viewport };
    const { pid, cdp } = await launchBrowser(
      forkName,
      profile.browser,
      port,
      chromeOpts,
      profile.secrets,
      profile.binary,
      profile.electron === true
    );

    await this.enableDomains(cdp);

    const connection: ProfileConnection = {
      backend: 'cdp',
      cdp,
      port,
      pid,
      electron: true,
      browserType: profile.browser,
      targetFilter: profile.targetFilter,
      key: forkName,
      profile: profile.name,
      forkedFrom: baseKey,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    this.connections.set(forkName, connection);
    await this.applyDefaultDownloadBehavior(connection, forkName);

    return { forkName, connection };
  }

  /** Connect the already-resolved effective profile; use the separate runtime key for all disk lookups. */
  private async connectProfile(
    effectiveProfile: BrowserProfile,
    target: string,
    key: ConnectionKey,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(key);
    const tunnelled = opts.persistRemote || target.startsWith('ssh:');
    // Native Arc and Firefox BiDi speak their own transport, not CDP — never
    // route them through the CDP reuse branch (which would probe /json/version
    // and wipe the runtime meta the Firefox driver wrote). connectEndpoint owns
    // their attach-or-launch decision.
    const nativeTransport =
      target.startsWith('arc-native:') || target.startsWith('firefox-bidi:');

    if (tunnelled) {
      // A leftover local chrome-data / pid file under this key is the
      // pre-T2 logged-out browser on THIS box. Attaching localhost CDP
      // here is the original bug. Only a recorded SSH tunnel is ours to
      // reuse, and connectSSH already does that via isOwnTunnel.
      const meta = readProfileRuntimeMeta(key);
      if (meta && meta.kind !== 'tunnel') {
        clearProfileRuntime(key);
      }
    } else if (existingInfo && !nativeTransport) {
      try {
        const { wsUrl, browser } = await discoverBrowserWsUrl(
          existingInfo.port,
          'localhost',
          effectiveProfile.name
        );
        verifyBrowserIdentity(browser, effectiveProfile.browser, existingInfo.port);
        const cdp = new CDPClient();
        await cdp.connect(wsUrl);
        await this.enableDomains(cdp);

        const tasks = this.loadTaskState(key);

        // Adopt ownership only after CDP and browser identity checks; update daemonPid while retaining
        // launch metadata.
        adoptProfileRuntimeOwner(key);

        return {
          backend: 'cdp',
          cdp,
          port: existingInfo.port,
          pid: existingInfo.pid,
          electron: effectiveProfile.electron,
          browserType: effectiveProfile.browser,
          targetFilter: effectiveProfile.targetFilter,
          tasks,
          sessionCache: new Map(),
        };
      } catch (err) {
        // A live PID without responsive CDP may be reused or stale; discard runtime files before
        // reconnecting to the configured endpoint.
        clearProfileRuntime(key);
      }
    }

    const conn = await this.connectEndpoint(effectiveProfile, target, key, opts);
    if (!conn) {
      throw new Error(`Could not connect to endpoint ${target} for profile "${effectiveProfile.name}"`);
    }
    return conn;
  }

  private async connectEndpoint(
    profile: BrowserProfile,
    endpoint: string,
    key: ConnectionKey,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection | null> {
    const url = new URL(endpoint);

    if (url.protocol === 'cdp:') {
      const conn = await connectLocal(endpoint, profile, key);
      await this.enableDomains(conn.cdp);
      return {
        backend: 'cdp',
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: conn.pid === 0 ? this.loadTaskState(key) : new Map(),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'ssh:') {
      const conn = await connectSSH(endpoint, profile, key, {
        persistRemote: opts.persistRemote,
      });
      await this.enableDomains(conn.cdp);
      return {
        backend: 'cdp',
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: new Map(),
        sessionCache: new Map(),
        cleanup: conn.cleanup,
      };
    }

    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const port = parseInt(url.port || (url.protocol === 'wss:' ? '443' : '80'), 10);
      const cdp = new CDPClient();
      try {
        await cdp.connect(endpoint);
      } catch {
        throw new BrowserCdpConnectionError(port, profile.name, url.hostname || 'localhost');
      }
      await this.enableDomains(cdp);
      return {
        backend: 'cdp',
        cdp,
        port: 0,
        pid: 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, url.hostname, profile.name);
      verifyBrowserIdentity(browser, profile.browser, port, url.hostname);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);
      return {
        backend: 'cdp',
        cdp,
        port,
        pid: 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
      };
    }

    // Firefox BiDi backend: `firefox-bidi://127.0.0.1:<port>` connects
    // over a WebDriver BiDi WebSocket. The driver attaches to a Firefox already
    // serving the port, else launches one headless bound to the pinned profile
    // directory, else fails loud (Firefox is single-instance per profile).
    if (url.protocol === 'firefox-bidi:') {
      if (!profile.firefox) {
        throw new Error(
          `Firefox profile "${profile.name}" has no discovered profile metadata. ` +
            `Re-select it with: browser use ${profile.name}`,
        );
      }
      const profileDir = profile.userDataDir;
      if (!profileDir) {
        throw new Error(`Firefox profile "${profile.name}" has no profile directory.`);
      }
      const port = parseInt(url.port || '9600', 10);
      const conn = await connectFirefox(profile, key, port, {
        profileDir,
        headless: profile.chrome?.headless,
      });
      return {
        backend: 'bidi',
        browserType: 'firefox',
        bidi: conn.bidi,
        firefoxProfile: profile.firefox,
        sessionId: conn.sessionId,
        profileDir,
        port: conn.port,
        pid: conn.pid,
        electron: false,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
      };
    }

    // Native Arc backend: `arc-native:` protocol connects through
    // Apple Events instead of CDP. No debugging port, no browser launch.
    if (url.protocol === 'arc-native:') {
      if (process.platform !== 'darwin') {
        throw new Error('Native Arc automation is only available on macOS');
      }
      if (!(await isArcRunning())) {
        throw new Error(
          'Arc is not running. Start Arc normally, then retry.\n' +
            'Native Arc automation drives your existing browser — it does not launch one.',
        );
      }

      if (!profile.arc) {
        throw new Error(
          `Native Arc profile "${profile.name}" has no stable native profile metadata. ` +
            `Re-select it with: browser use arc-<profile-id>`,
        );
      }

      return {
        port: 0,
        pid: 0,
        electron: false,
        browserType: 'arc',
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
        backend: 'arc-native',
        arcProfile: profile.arc,
      };
    }

    return null;
  }

  private async enableDomains(cdp: CDPClient): Promise<void> {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  /** Create CDP targets through this guard; Arc must refuse because Target.createTarget crashes it. */
  private async createPageTarget(
    conn: ProfileConnection,
    params: { url: string; newWindow?: boolean },
  ): Promise<{ targetId: string }> {
    if (conn.browserType === 'arc') {
      throw arcNotDrivableError(conn.profile);
    }
    // Firefox opens tabs through the BiDi driver, never Target.createTarget.
    requireCdp(conn, 'createTab');
    return (await conn.cdp.send('Target.createTarget', params)) as { targetId: string };
  }

  private async getOrCreateWindow(conn: CdpProfileConnection): Promise<string> {
    // Already have a window for this profile?
    if (conn.windowId) {
      // Verify it still exists via CDP
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
      };
      if (targetInfos.some((t) => t.targetId === conn.windowId && t.type === 'page')) {
        return conn.windowId;
      }
      // Window was closed, fall through to find/create new
    }

    // Check if browser already has a page target we can use
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
    };
    const existing = pickWindowTarget(targetInfos, conn.targetFilter);
    if (existing) {
      conn.windowId = existing.targetId;
      return existing.targetId;
    }

    // An unmatched explicit filter must fail with candidates; creating a target would leave an
    // invisible orphan tab.
    if (parseTargetFilter(conn.targetFilter)) {
      const candidates = targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => `  - url=${t.url ?? ''} title=${t.title ?? ''}`)
        .join('\n');
      throw new Error(
        `Target filter ${JSON.stringify(conn.targetFilter)} matched no page target.\n` +
          `Available page targets:\n${candidates || '  (none)'}`
      );
    }

    // First ever use - create window
    const result = await this.createPageTarget(conn, {
      url: 'about:blank',
      newWindow: true,
    });
    conn.windowId = result.targetId;
    return result.targetId;
  }

  private hasTaskNamed(name: string): boolean {
    for (const conn of this.connections.values()) {
      if (this.lookupTaskOnConn(conn, name)) return true;
    }
    return false;
  }

  /** The (connection, task) a handle names anywhere, or undefined. */
  private findTaskByHandle(handle: string): { conn: ProfileConnection; task: Task } | undefined {
    for (const conn of this.connections.values()) {
      const task = this.lookupTaskOnConn(conn, handle);
      if (task) return { conn, task };
    }
    return undefined;
  }

  /** Reuse a named task only when caller, profile and endpoint match; conflicts throw under start's
   * named-task lock. */
  private async retryNamedStart(
    existing: { conn: ProfileConnection; task: Task },
    profileName: string,
    routed: { key: ConnectionKey; device: string },
    opts: StartOptions,
  ): Promise<StartResult> {
    const { conn, task } = existing;
    const existingKey = conn.key ?? task.profile;

    // Profile + endpoint must match what this retry asked for.
    if (!keyBelongsToProfile(existingKey, profileName)) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists on profile "${parseConnectionKey(existingKey).profile}", not "${profileName}".`,
          `Next: stop it first (browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }
    const wantEndpoint = parseConnectionKey(routed.key).endpoint;
    const haveEndpoint = parseConnectionKey(existingKey).endpoint;
    if (opts.endpointName && wantEndpoint !== haveEndpoint) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists on endpoint "${haveEndpoint}", not "${wantEndpoint}".`,
          `Next: stop it first (browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }

    // Caller identity must match. Both identity-less (a human shell) is fine;
    // otherwise the SAME session/launch must own it — never another caller's.
    const caller = { sessionId: opts.sessionId, launchId: opts.launchId };
    const bothAnon = !task.sessionId && !task.launchId && !caller.sessionId && !caller.launchId;
    if (!bothAnon && !taskMatchesCaller(task, caller)) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists and belongs to a different caller.`,
          `Next: stop it first (browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }

    // Carry navigate's actual result; a retry without a URL performs no page operation and reports
    // neither create nor refresh.
    let firstOpen: PageOpenResult;
    if (opts.url) {
      const nav = await this.navigate(task.name, opts.url, existingKey, { wait: true });
      firstOpen = { tabId: nav.tabId, created: nav.created, refreshed: nav.refreshed, message: nav.message };
    } else {
      firstOpen = { tabId: task.currentTabId, created: false, refreshed: false };
    }

    return {
      task: task.id,
      name: task.name,
      tabId: firstOpen.tabId,
      profile: profileName,
      key: existingKey,
      device: routed.device,
      reused: true,
      firstOpen,
    };
  }

  /** Map key for a task on a connection (tasks are keyed by `name`). */
  private taskMapKey(conn: ProfileConnection, task: Task): string | undefined {
    for (const [key, t] of conn.tasks) {
      if (t === task || t.id === task.id || t.name === task.name) return key;
    }
    return undefined;
  }

  /** Find a task by map key, id, or name on one connection. */
  private lookupTaskOnConn(conn: ProfileConnection, handle: string): Task | undefined {
    const direct = conn.tasks.get(handle);
    if (direct) return direct;
    for (const task of conn.tasks.values()) {
      if (task.id === handle || task.name === handle) return task;
    }
    return undefined;
  }

  private maybeUpdateLabelFromUrl(conn: ProfileConnection, task: Task, url: string): void {
    if (task.label && task.label !== 'untitled') return;
    const next = deriveTaskLabel({ url, existing: task.label });
    if (next === task.label) return;
    task.label = next;
    void this.saveTaskState(task.profile, conn.tasks).catch(() => { /* best-effort */ });
  }

  /** Resolve explicit or unambiguous caller tasks; reject ambiguity and create only when allowed,
   * otherwise return null. */
  async resolveOrCreateTask(opts: {
    /** Whether the CALLER was dispatched here by a fleet `--device` hop. */
    fleetRemote?: boolean;
    task?: string;
    profile?: string;
    actor?: string;
    launchId?: string;
    sessionId?: string;
    createIfMissing: boolean;
    title?: string;
    url?: string;
  }): Promise<{
    conn: ProfileConnection;
    task: Task;
    key: ConnectionKey;
    created: boolean;
    device?: string;
    /** Carry start's actual page result so IPC does not repeat navigation or misreport adoption as
     * creation. */
    firstOpen?: PageOpenResult;
  } | null> {
    // Gate every attach, create and close before resolution using the request marker, never the
    // daemon's environment.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });
    assertBrowserHomeReady();

    if (opts.task) {
      const found = await this.findTask(opts.task, opts.profile);
      return { ...found, created: false };
    }

    // Serialize implicit creation per caller/profile; separate create: and task: keys prevent nested
    // deadlocks.
    const createKey = `create:${opts.sessionId ?? opts.launchId ?? 'anon'}:${opts.profile ?? 'default'}`;
    return this.runExclusive(createKey, () => this.resolveOrCreateByIdentity(opts));
  }

  private async resolveOrCreateByIdentity(opts: {
    fleetRemote?: boolean;
    profile?: string;
    actor?: string;
    launchId?: string;
    sessionId?: string;
    createIfMissing: boolean;
    title?: string;
    url?: string;
  }): Promise<{
    conn: ProfileConnection;
    task: Task;
    key: ConnectionKey;
    created: boolean;
    device?: string;
    firstOpen?: PageOpenResult;
  } | null> {
    // After a daemon restart the connections map is empty while tasks.json still
    // holds live tasks. Rehydrate before identity matching so done/screenshot
    // without --task still find the caller's task.
    await this.rehydrateAllFromDisk();

    const caller = {
      sessionId: opts.sessionId,
      launchId: opts.launchId,
    };
    const matches = this.listTasksForCaller(caller);

    if (matches.length === 1) {
      const m = matches[0]!;
      await this.prepareTask(m.conn, m.task);
      await this.touchTask(m.conn, m.task);
      return { conn: m.conn, task: m.task, key: m.key, created: false };
    }

    if (matches.length > 1) {
      const lines = matches.map((m) => {
        const ageMs = Date.now() - m.task.createdAt;
        const age =
          ageMs < 60_000
            ? `${Math.round(ageMs / 1000)}s`
            : `${Math.round(ageMs / 60_000)}m`;
        const label = m.task.label ?? m.task.name;
        const url = this.currentUrlHint(m.conn, m.task) ?? '-';
        return `  ${label}  id=${m.task.name}  url=${url}  age=${age}`;
      });
      throw new Error(
        actionable(
          `Multiple browser tasks for this session — pass --task <name>:`,
          ...lines,
          `Next: browser status`,
        ),
      );
    }

    // Zero matches for this caller.
    if (!opts.createIfMissing) return null;

    // Consent was checked before default resolution; missing launchable defaults throw without
    // creating profiles.

    // Implicit start on the default / named profile.
    let profileName = opts.profile;
    if (!profileName) {
      const { ensureDefaultBrowserProfile } = await import('./profiles.js');
      const detected = await ensureDefaultBrowserProfile();
      profileName = detected.name;
    }
    const started = await this.start(profileName, {
      fleetRemote: opts.fleetRemote,
      url: opts.url,
      actor: opts.actor,
      launchId: opts.launchId,
      sessionId: opts.sessionId,
      title: opts.title,
    });
    return {
      ...(await this.findTask(started.name, started.profile)),
      created: true,
      device: started.device,
      // `start` already opened opts.url on this tab; the handler must not open
      // it a second time (a duplicate tab for tab-add; a redundant reload for
      // navigate). Carry the ACTUAL page result so created/refreshed are truthful.
      firstOpen: started.firstOpen,
    };
  }

  private listTasksForCaller(caller: {
    sessionId?: string;
    launchId?: string;
  }): Array<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> {
    const out: Array<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> = [];
    const hasIdentity = !!(caller.sessionId || caller.launchId);

    for (const [key, conn] of this.connections) {
      for (const task of conn.tasks.values()) {
        if (hasIdentity) {
          if (taskMatchesCaller(task, caller)) {
            out.push({ conn, task, key: conn.key ?? key });
          }
        } else {
          // No caller identity: only match tasks that also lack identity
          // (a human-driven shell). If there is exactly one live task total,
          // the single-task path still needs that listed — fall through below.
          if (!task.sessionId && !task.launchId) {
            out.push({ conn, task, key: conn.key ?? key });
          }
        }
      }
    }

    // No-identity caller with zero unscoped matches: if the daemon holds
    // exactly one live task that ALSO has no identity (a human-started one),
    // use it. Never steal a task stamped with another caller's session/launch.
    if (!hasIdentity && out.length === 0) {
      const unowned = this.listTasks().filter((t) => !t.task.sessionId && !t.task.launchId);
      if (unowned.length === 1) {
        const only = unowned[0]!;
        const conn = this.connections.get(only.profile) ??
          [...this.connections.entries()].find(([, c]) =>
            c.tasks.has(only.task.name) || [...c.tasks.values()].includes(only.task),
          )?.[1];
        if (conn) {
          out.push({ conn, task: only.task, key: only.profile });
        }
      }
    }

    return out;
  }

  private currentUrlHint(conn: ProfileConnection, task: Task): string | undefined {
    const shortId = task.currentTabId;
    if (!shortId) return undefined;
    const cdpId = task.tabs[shortId];
    if (!cdpId) return undefined;
    const cached = conn.targetCache?.targets.find((t) => t.targetId === cdpId);
    return cached?.url;
  }

  /** Stamp real use centrally in findTask; coalesce disk writes so daemon restarts retain recent
   * activity. */
  private async touchTask(conn: ProfileConnection, task: Task): Promise<void> {
    const now = Date.now();
    task.lastActionAt = now;

    const last = this.lastTouchPersist.get(task.profile) ?? 0;
    if (now - last < BrowserService.TOUCH_PERSIST_INTERVAL_MS) return;
    this.lastTouchPersist.set(task.profile, now);
    try {
      await this.saveTaskState(task.profile, conn.tasks);
    } catch {
      // Durability here is best-effort — the in-memory stamp above is
      // authoritative for the running daemon — and an unwritable runtime dir
      // must not turn a working browser action into a failure. Same guard the
      // `recordBrowserSession` call in `start` uses for the same reason.
    }
  }

  private async prepareTask(conn: ProfileConnection, task: Task): Promise<void> {
    if (conn.backend !== 'arc-native') return;
    await this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const native = this.requireArcTask(task);
      if (native.profileId !== conn.arcProfile.profileId) {
        throw new Error(
          `Arc task profile ${JSON.stringify(native.profileId)} does not match connected profile ` +
            `${JSON.stringify(conn.arcProfile.profileId)}.`,
        );
      }
    });
  }

  private async findTask(
    taskId: string,
    profileRef?: ProfileName | ConnectionKey,
  ): Promise<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> {
    if (profileRef) {
      // Accept bare profile names against composite connection keys.
      // One rule: an exact runtime key, else every key belonging to that bare
      // profile. Callers pass whichever they hold — the composite is theirs to
      // ignore.
      const keys = [...this.connections.keys()].filter(
        (k) => k === profileRef || keyBelongsToProfile(k, profileRef),
      );
      for (const key of keys) {
        const conn = this.connections.get(key)!;
        const task = this.lookupTaskOnConn(conn, taskId);
        if (task) {
          await this.prepareTask(conn, task);
          await this.touchTask(conn, task);
          return { conn, task, key: conn.key ?? key };
        }
      }
      // RAM miss → rehydrate from disk for this profile.
      const rehydrated = await this.rehydrateTaskFromDisk(taskId, profileRef);
      if (rehydrated) {
        await this.prepareTask(rehydrated.conn, rehydrated.task);
        await this.touchTask(rehydrated.conn, rehydrated.task);
        return rehydrated;
      }
      throw new Error(
        actionable(
          `Task "${taskId}" not found on profile "${profileRef}".`,
          `Next: browser status --profile ${parseConnectionKey(profileRef).profile}`,
        ),
      );
    }

    for (const [key, conn] of this.connections) {
      const task = this.lookupTaskOnConn(conn, taskId);
      if (task) {
        await this.prepareTask(conn, task);
        await this.touchTask(conn, task);
        return { conn, task, key: conn.key ?? key };
      }
    }

    // RAM miss after a daemon restart: tasks.json still has the task and
    // meta.json still has the browser pid/port. Reconnect and adopt.
    const rehydrated = await this.rehydrateTaskFromDisk(taskId);
    if (rehydrated) {
      await this.prepareTask(rehydrated.conn, rehydrated.task);
      await this.touchTask(rehydrated.conn, rehydrated.task);
      return rehydrated;
    }

    const live = this.listTasks()
      .map(({ task }) => task.label ?? task.name)
      .join(', ');
    throw new Error(
      actionable(
        `Task "${taskId}" not found.`,
        `Active tasks: ${live || 'none'}`,
        `It may have been closed by the idle reaper (30 min).`,
        `Next: browser status  |  browser navigate <url>`,
      ),
    );
  }

  /** Soft-attach without launching or clearing runtime files; return null when unavailable so callers
   * reconcile disk state. */
  private async attachRunningProfile(
    key: ConnectionKey,
    diskTasks: Map<string, Task>,
    /** Share Arc liveness within one status pass; probe directly when no shared result is supplied. */
    arcRunning?: () => Promise<boolean>,
  ): Promise<ProfileConnection | null> {
    const { profile: bare, endpoint: endpointFromKey } = parseConnectionKey(key);
    const profile = await getProfile(bare);
    if (!profile) return null;

    let resolved;
    try {
      // Legacy keys encode the preset (`endpoint-0`). New keys encode the
      // declaring device, which is not a preset name — resolve via registry.
      if (endpointFromKey && /^endpoint-\d+$/.test(endpointFromKey)) {
        resolved = resolveEndpoint(profile, endpointFromKey);
      } else {
        const routed = resolveBrowserTarget(bare);
        if (!routed.local) return null;
        resolved = { name: routed.device, target: routed.target };
      }
    } catch {
      return null;
    }

    // Native Arc endpoints: reconnect via the native driver if Arc
    // is still running. No port, no CDP — just verify Arc is alive and restore
    // the task state.
    if (resolved.target.startsWith('arc-native:')) {
      if (process.platform !== 'darwin' || !(await (arcRunning ?? isArcRunning)())) return null;
      const tasks = this.loadTaskState(key);
      for (const [k, t] of diskTasks) {
        if (!tasks.has(k)) tasks.set(k, t);
      }
      if (!profile.arc) return null;
      return {
        port: 0,
        pid: 0,
        electron: false,
        browserType: 'arc',
        targetFilter: profile.targetFilter,
        key,
        profile: bare,
        tasks,
        sessionCache: new Map(),
        backend: 'arc-native',
        arcProfile: profile.arc,
      };
    }

    // Reattach to the existing Firefox BiDi listener after daemon restart; failure falls through to
    // disk reconciliation.
    if (resolved.target.startsWith('firefox-bidi:')) {
      if (!profile.firefox || !profile.userDataDir) return null;
      const port = parseEndpointUrl(resolved.target)?.port ?? 9600;
      try {
        const ff = await connectFirefox(profile, key, port, { profileDir: profile.userDataDir });
        // A served port that accepted a fresh BiDi session is this profile's own
        // Firefox, so claim the record for this daemon (see the local-CDP claim
        // below for why adoption waits for a proven attach).
        adoptProfileRuntimeOwner(key);
        const tasks = this.loadTaskState(key);
        for (const [k, t] of diskTasks) {
          if (!tasks.has(k)) tasks.set(k, t);
        }
        return {
          backend: 'bidi',
          browserType: 'firefox',
          bidi: ff.bidi,
          firefoxProfile: profile.firefox,
          sessionId: ff.sessionId,
          profileDir: profile.userDataDir,
          port: ff.port,
          pid: ff.pid,
          electron: false,
          targetFilter: profile.targetFilter,
          key,
          profile: bare,
          tasks,
          sessionCache: new Map(),
        };
      } catch {
        return null;
      }
    }

    const existingInfo = getRunningChromeInfo(key);
    const parsed = parseEndpointUrl(resolved.target);
    const port = existingInfo?.port ?? parsed?.port;
    if (port === undefined) return null;
    const host = parsed?.host && parsed.host !== 'localhost' ? parsed.host : 'localhost';

    // Restore a lost SSH tunnel to the existing remote browser, then merge disk tasks; failure returns
    // null for reconciliation.
    if (resolved.target.startsWith('ssh:')) {
      try {
        const conn = await connectSSH(resolved.target, profile, key, { persistRemote: true });
        await this.enableDomains(conn.cdp);
        const tasks = this.loadTaskState(key);
        for (const [k, t] of diskTasks) {
          if (!tasks.has(k)) tasks.set(k, t);
        }
        return {
          backend: 'cdp',
          cdp: conn.cdp,
          port: conn.port,
          pid: conn.pid,
          electron: profile.electron,
          browserType: profile.browser,
          targetFilter: resolved.targetFilter ?? profile.targetFilter,
          key,
          profile: bare,
          tasks,
          sessionCache: new Map(),
          // Carry the tunnel teardown so removing this connection kills the
          // ssh hop — otherwise it leaks across the next restart (see the
          // `cleanup` docblock on ProfileConnection).
          cleanup: conn.cleanup,
        };
      } catch {
        return null;
      }
    }

    try {
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, host, bare);
      verifyBrowserIdentity(browser, profile.browser, port, host);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);
      // Transfer daemon ownership only after browser identity and CDP attach succeed; ambiguity leaves
      // runtime state untouched.
      adoptProfileRuntimeOwner(key);

      const tasks = this.loadTaskState(key);
      for (const [k, t] of diskTasks) {
        if (!tasks.has(k)) tasks.set(k, t);
      }

      const conn: ProfileConnection = {
        backend: 'cdp',
        cdp,
        port,
        pid: existingInfo?.pid ?? 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: resolved.targetFilter ?? profile.targetFilter,
        key,
        profile: bare,
        tasks,
        sessionCache: new Map(),
      };
      return conn;
    } catch {
      return null;
    }
  }

  /** Register the winning connection; release a concurrent loser without killing an SSH tunnel shared
   * with the winner. */
  private registerRehydratedConnection(
    key: ConnectionKey,
    conn: ProfileConnection,
  ): ProfileConnection {
    const existing = this.connections.get(key);
    if (!existing) {
      this.connections.set(key, conn);
      return conn;
    }
    const sharesTunnel =
      conn.pid !== 0 && conn.pid === existing.pid && conn.port === existing.port;
    if (conn.pid !== 0 && !sharesTunnel && conn.cleanup) {
      // Distinct tunnel — full teardown so this loser's tunnel doesn't leak.
      try { conn.cleanup(); } catch { /* best effort — the winner stays live */ }
    } else {
      // Shared/borrowed tunnel (or a local connection with no tunnel): close
      // only our own client; killing the tunnel would break the winner.
      if (conn.backend === 'bidi') {
        try { conn.bidi.close(); } catch { /* best effort */ }
      } else if (conn.backend !== 'arc-native') {
        try { conn.cdp.close(); } catch { /* best effort */ }
      }
    }
    return existing;
  }

  /** Reconnect saved live runtimes before caller resolution so daemon restart does not hide tasks. */
  private async rehydrateAllFromDisk(
    arcRunning?: () => Promise<boolean>,
    /** An error sink lets read-only rehydration continue past one failed runtime; without it, errors
     * propagate. */
    onError?: (key: ConnectionKey, error: unknown) => void,
  ): Promise<void> {
    const runtimeRoot = getBrowserRuntimeDir();
    let dirNames: string[] = [];
    try {
      dirNames = fs.readdirSync(runtimeRoot).filter((d) => {
        try {
          return fs.statSync(path.join(runtimeRoot, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return;
    }

    // Back off costly attach misses so offline SSH profiles do not delay every status call;
    // task-addressed recovery still tries.
    const now = Date.now();
    for (const dirName of dirNames) {
      // A runtime dir name IS a connection key — that is what wrote it.
      const key = asConnectionKey(dirName);
      if (this.connections.has(key)) continue;
      // Skip non-runtime dirs (e.g. profiles/)
      if (dirName === 'profiles' || dirName === 'sessions' || dirName === 'exports') continue;
      const missedAt = this.attachMisses.get(key);
      if (missedAt !== undefined && now - missedAt < BrowserService.ATTACH_RETRY_MS) continue;
      try {
        const tasks = this.loadTaskState(key);
        if (tasks.size === 0) continue;
        // Soft attach only — never launch / never clear pid files.
        const attachStart = Date.now();
        const conn = await this.attachRunningProfile(key, tasks, arcRunning);
        if (!conn) {
          if (Date.now() - attachStart >= 1_000) this.attachMisses.set(key, now);
          continue;
        }
        this.attachMisses.delete(key);
        // A concurrent rehydrate may have registered one for this key while we
        // awaited the attach; keep the winner and tear our loser's tunnel down.
        const registered = this.registerRehydratedConnection(key, conn);
        if (registered !== conn) continue;
        try {
          if (conn.backend !== 'arc-native' && conn.backend !== 'bidi') await this.applyDefaultDownloadBehavior(conn, key);
        } catch {
          // Non-fatal for rehydrate.
        }
      } catch (err) {
        if (!onError) throw err;
        onError(key, err);
      }
    }
  }

  /** Recover a task from saved runtime state by soft-attaching; never launch browsers or clear runtime
   * files. */
  private async rehydrateTaskFromDisk(
    taskId: string,
    profileHint?: ProfileName | ConnectionKey,
  ): Promise<{ conn: ProfileConnection; task: Task; key: ConnectionKey } | null> {
    const runtimeRoot = getBrowserRuntimeDir();
    let dirNames: string[] = [];
    try {
      dirNames = fs.readdirSync(runtimeRoot).filter((d) => {
        try {
          return fs.statSync(path.join(runtimeRoot, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }

    if (profileHint) {
      dirNames = dirNames.filter(
        (d) => d === profileHint || keyBelongsToProfile(d, profileHint),
      );
    }

    for (const dirName of dirNames) {
      if (dirName === 'profiles' || dirName === 'sessions' || dirName === 'exports') continue;
      const key = asConnectionKey(dirName);
      const tasks = this.loadTaskState(key);
      let found: Task | undefined;
      for (const task of tasks.values()) {
        if (task.id === taskId || task.name === taskId) {
          found = task;
          break;
        }
      }
      // Also allow map-key match
      if (!found) found = tasks.get(taskId);
      if (!found) continue;

      // Already connected under this key?
      let conn = this.connections.get(key);
      if (!conn) {
        const attached = await this.attachRunningProfile(key, tasks);
        if (!attached) {
          // CDP down — cannot rehydrate a live connection; caller will error.
          continue;
        }
        // Keep whichever connection a concurrent rehydrate registered first and
        // tear our loser's tunnel down instead of leaking it (see the helper).
        conn = this.registerRehydratedConnection(key, attached);
        if (conn === attached) {
          try {
            if (conn.backend !== 'arc-native' && conn.backend !== 'bidi') await this.applyDefaultDownloadBehavior(conn, key);
          } catch {
            // Non-fatal.
          }
        }
      }

      const task = this.lookupTaskOnConn(conn, taskId) ?? found;
      // Ensure the rehydrated task is on the connection map.
      if (!this.lookupTaskOnConn(conn, task.name)) {
        conn.tasks.set(task.name, task);
      }
      return { conn, task, key: conn.key ?? key };
    }
    return null;
  }

  private async getTabsForTask(cdp: CDPClient, task: Task): Promise<TabInfo[]> {
    const targets = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: TabInfo[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          task: task.name,
        });
      }
    }
    return tabs;
  }

  /** Live status for ONE registered connection, addressed by its runtime key. */
  private async getProfileStatus(key: ConnectionKey, arc?: ArcStatusReaders): Promise<ProfileStatus | null> {
    const conn = this.connections.get(key);
    if (!conn) return null;

    if (conn.backend === 'arc-native') {
      // One snapshot and one liveness read for the whole pass, shared across
      // every task and every Arc profile (built in `status`).
      const spaces = arc?.spaces ?? onceAsync(() => enumerateArcSpaces());
      const running = arc?.running ?? onceAsync(() => isArcRunning());
      const tasks: TaskStatus[] = [];
      for (const task of conn.tasks.values()) {
        // The moved-tab refusal is the ownership guarantee actions rely on and
        // stays strict. `status` only reads, so one stale task must not take down
        // its neighbours: report what disk knows plus the reason, and leave
        // `tabs` ABSENT rather than empty so nothing claims a moved tab is live.
        let tabs: TabInfo[] = [];
        let unavailable: string | undefined;
        try {
          tabs = await this.listArcTaskTabsFromSnapshot(task, spaces);
        } catch (err) {
          unavailable = err instanceof Error ? err.message : String(err);
        }
        const domains = tabs.flatMap((tab) => {
          try {
            const domain = new URL(tab.url).hostname.replace(/^www\./, '');
            return domain && domain !== 'blank' ? [domain] : [];
          } catch {
            return [];
          }
        });
        tasks.push({
          id: task.id,
          name: task.name,
          label: task.label ?? task.name,
          tabCount: Object.keys(task.tabs).length,
          currentTabId: task.currentTabId,
          createdAt: task.createdAt,
          tabs: tabs.length ? tabs : undefined,
          domains: [...new Set(domains)],
          unavailable,
        });
      }
      const parsed = parseConnectionKey(key);
      return {
        name: conn.profile ?? parsed.profile,
        endpoint: parsed.endpoint,
        key,
        running: await running(),
        port: 0,
        pid: 0,
        tasks,
      };
    }

    if (conn.backend === 'bidi') {
      const tasks: TaskStatus[] = [];
      for (const task of conn.tasks.values()) {
        let tabs: TabInfo[] = [];
        try { tabs = await this.listFirefoxTaskTabs(conn, task); } catch { /* Firefox down */ }
        const domains = tabs.flatMap((tab) => {
          try {
            const domain = new URL(tab.url).hostname.replace(/^www\./, '');
            return domain && domain !== 'blank' ? [domain] : [];
          } catch { return []; }
        });
        tasks.push({
          id: task.id,
          name: task.name,
          label: task.label ?? task.name,
          tabCount: Object.keys(task.tabs).length,
          currentTabId: task.currentTabId,
          createdAt: task.createdAt,
          tabs: tabs.length ? tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, current: t.current })) : undefined,
          domains: domains.length ? [...new Set(domains)] : undefined,
        });
      }
      const parsed = parseConnectionKey(key);
      return {
        name: conn.profile ?? parsed.profile,
        endpoint: parsed.endpoint,
        key,
        running: conn.bidi.isOpen,
        port: conn.port,
        pid: conn.pid,
        tasks,
      };
    }

    // Fetch all targets once for efficiency
    let targets: Array<{ targetId: string; url: string; title: string }> = [];
    try {
      const result = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string; title: string }>;
      };
      targets = result.targetInfos;
    } catch {
      // CDP not responding, fall back to metadata only
    }

    const tasks: TaskStatus[] = [];
    for (const [, task] of conn.tasks) {
      const tabs: Array<{ id: string; url: string; title?: string; current?: boolean }> = [];
      const domainSet = new Set<string>();

      for (const [shortId, cdpId] of Object.entries(task.tabs)) {
        const target = targets.find((t) => t.targetId === cdpId);
        if (target) {
          tabs.push({
            id: shortId,
            url: target.url,
            title: target.title,
            current: shortId === task.currentTabId,
          });
          try {
            const domain = new URL(target.url).hostname.replace(/^www\./, '');
            if (domain && domain !== 'blank') domainSet.add(domain);
          } catch {
            // invalid URL
          }
        }
      }

      tasks.push({
        id: task.id,
        name: task.name,
        label: task.label ?? task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
        tabs: tabs.length > 0 ? tabs : undefined,
        domains: domainSet.size > 0 ? Array.from(domainSet) : undefined,
      });
    }

    const parsed = parseConnectionKey(key);
    const bare = conn.profile ?? parsed.profile;
    const profile = await getProfile(bare);
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: bare,
      endpoint: parsed.endpoint,
      key,
      running: true,
      port: conn.port,
      pid: conn.pid,
      configuredPort: configuredPort !== conn.port ? configuredPort : undefined,
      tasks,
    };
  }

  private async getTarget(
    conn: CdpProfileConnection,
    tabId: string
  ): Promise<TargetInfo | undefined> {
    const now = Date.now();
    if (!conn.targetCache || now - conn.targetCache.ts > 1000) {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: TargetInfo[];
      };
      conn.targetCache = { targets: targetInfos, ts: now };
    }

    return conn.targetCache.targets.find((target) => target.targetId === tabId);
  }

  private async getSessionId(conn: CdpProfileConnection, tabId: string): Promise<string> {
    const cachedSessionId = conn.sessionCache.get(tabId);
    if (cachedSessionId) {
      return cachedSessionId;
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };

    // Only attached browsers need the webdriver shim; mirror native prototype/false semantics and
    // tolerate non-page targets.
    if (conn.pid === 0) {
      try {
        await this.enablePageForSession(conn, sessionId);
        await conn.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source:
            "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:true});",
        }, sessionId);
      } catch {
        // Target doesn't support Page domain — nothing to inject.
      }
    }

    await this.answerDialogs(conn, sessionId);
    conn.sessionCache.set(tabId, sessionId);
    return sessionId;
  }

  /** Dialogs answered per tab session since the caller last asked (`takeDialogs`). */
  private readonly answeredDialogs = new Map<string, string[]>();
  /** confirm() and prompt() dialogs waiting for `browser dialog accept|dismiss`, per tab session. */
  private readonly openDialogs = new Map<string, string>();
  private readonly dialogWaiters = new Map<string, Set<(said: string) => void>>();
  private readonly dialogWatchers = new WeakSet<CDPClient>();

  /** Accept alerts and leave-page prompts to unblock scripts; leave confirm/prompt questions for
   * explicit caller answers. */
  private async answerDialogs(conn: CdpProfileConnection, sessionId: string): Promise<void> {
    if (!this.dialogWatchers.has(conn.cdp)) {
      this.dialogWatchers.add(conn.cdp);
      conn.cdp.on('Page.javascriptDialogOpening', (params, sid) => {
        if (!sid) return;
        const { type, message } = params as { type: string; message: string };
        const said = message ? `${type} "${message.length > 200 ? `${message.slice(0, 200)}…` : message}"` : type;
        if (type === 'confirm' || type === 'prompt') {
          this.openDialogs.set(sid, said);
          for (const wake of this.dialogWaiters.get(sid) ?? []) wake(said);
          return;
        }
        this.answeredDialogs.set(sid, [...(this.answeredDialogs.get(sid) ?? []), said]);
        void conn.cdp.send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
      });
      conn.cdp.on('Page.javascriptDialogClosed', (_params, sid) => {
        if (sid) this.openDialogs.delete(sid);
      });
    }
    try {
      await this.enablePageForSession(conn, sessionId);
    } catch {
      // A target without the Page domain (a worker) opens no dialogs.
    }
  }

  /** The CDP sessions of a task's tabs, without creating any. */
  private taskSessions(taskId: string): { conn: CdpProfileConnection; sessions: string[] } | undefined {
    for (const conn of this.connections.values()) {
      const task = conn.tasks.get(taskId) ?? [...conn.tasks.values()].find((t) => t.name === taskId);
      if (!task) continue;
      if (conn.backend === 'arc-native' || conn.backend === 'bidi') return undefined;
      const sessions = Object.values(task.tabs).map((t) => conn.sessionCache.get(t)).filter((s): s is string => !!s);
      return { conn, sessions };
    }
    return undefined;
  }

  /** The dialogs accepted on this task's tabs since the last call, oldest first. */
  takeDialogs(taskId: string): string[] {
    const taken: string[] = [];
    for (const sid of this.taskSessions(taskId)?.sessions ?? []) {
      const said = this.answeredDialogs.get(sid);
      if (said) { taken.push(...said); this.answeredDialogs.delete(sid); }
    }
    return taken;
  }

  /** The confirm() or prompt() a task's tab is showing, if any. */
  openDialog(taskId: string): string | undefined {
    for (const sid of this.taskSessions(taskId)?.sessions ?? []) {
      const said = this.openDialogs.get(sid);
      if (said) return said;
    }
    return undefined;
  }

  /**
   * `browser dialog accept|dismiss [--text]`: answer the question a task's tab
   * is showing, or undefined when none is open (an alert was already accepted).
   */
  async answerDialog(taskId: string, accept: boolean, promptText?: string): Promise<string | undefined> {
    const found = this.taskSessions(taskId);
    if (!found) await this.findTask(taskId);
    for (const sid of found?.sessions ?? []) {
      const said = this.openDialogs.get(sid);
      if (!said) continue;
      await found!.conn.cdp.send('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined ? { promptText } : {}) }, sid);
      this.openDialogs.delete(sid);
      return said;
    }
    return undefined;
  }

  /** Return early when input opens a confirm/prompt; awaiting the input alone would block until the
   * dialog is answered. */
  private async raceDialog(sessionId: string, action: Promise<unknown>): Promise<string | undefined> {
    let wake!: (said: string) => void;
    const opened = new Promise<string>((resolve) => { wake = resolve; });
    const waiters = this.dialogWaiters.get(sessionId) ?? new Set();
    waiters.add(wake);
    this.dialogWaiters.set(sessionId, waiters);
    try {
      return await Promise.race([action.then(() => undefined), opened]);
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.dialogWaiters.delete(sessionId);
    }
  }

  private invalidateTargetCache(conn: ProfileConnection): void {
    conn.targetCache = undefined;
  }

  private readonly pendingSaves = new Map<ConnectionKey, ReturnType<typeof setTimeout>>();

  /** Coalesce ref-cache persistence so each listing does not rewrite the whole tasks file. */
  private saveTaskStateSoon(key: ConnectionKey, tasks: Map<string, Task>): void {
    if (this.pendingSaves.has(key)) return;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(key);
      // The connection may have been rebuilt since; persist what it holds now.
      void this.saveTaskState(key, this.connections.get(key)?.tasks ?? tasks).catch((error) => {
        emit('browser.task_state_failed', { profile: parseConnectionKey(key).profile, error: error instanceof Error ? error.message : String(error) });
      });
    }, 500);
    timer.unref?.();
    this.pendingSaves.set(key, timer);
  }

  private async saveTaskState(key: ConnectionKey, tasks: Map<string, Task>): Promise<void> {
    // Serialize whole-file task writes per runtime; separate persist: keys avoid deadlocks with
    // task/create locks.
    await this.runExclusive(`persist:${key}`, async () => {
      const runtimeDir = getProfileRuntimeDir(key);
      await fs.promises.mkdir(runtimeDir, { recursive: true });

      const state = Object.fromEntries(tasks);
      // Write to a temp sibling then rename, so a reader never sees a half-written
      // file even if the process dies mid-write (rename is atomic on one fs).
      const target = path.join(runtimeDir, 'tasks.json');
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(state));
      await fs.promises.rename(tmp, target);
      for (const task of tasks.values()) this.recordTaskHistory(task);
    });
  }

  /** Keyed by the live Task object, so an entry goes away with its task on
   *  every exit path: close, reap, a dropped connection or a state reload. */
  private readonly historyWrites = new WeakMap<Task, { metadata: string; countedAt: number; counts: ReturnType<typeof countByKind> }>();

  private recordTaskHistory(task: Task, final = false): void {
    const metadata = JSON.stringify([task.createdAt, task.lastActionAt, task.sessionId, task.launchId, task.owner]);
    const previous = this.historyWrites.get(task);
    if (!final && previous?.metadata === metadata) return;
    const now = Date.now();
    try {
      const recount = final || !previous || now - previous.countedAt >= 60_000;
      const counts = recount ? countByKind(listTaskArtifacts(getProfileSessionsDir(task.profile, task.name), task.name)) : previous.counts;
      recordBrowserSession({
        profile: task.profile, task: task.name, sessionId: task.sessionId, machine: os.hostname(),
        launchId: task.launchId, actor: task.owner, startedAt: task.createdAt,
        lastActivity: task.lastActionAt, captureDir: getProfileSessionsDir(task.profile, task.name),
        counts,
      });
      this.historyWrites.set(task, { metadata, countedAt: recount ? now : previous!.countedAt, counts });
    } catch (error) {
      emit('browser.history_failed', { profile: parseConnectionKey(task.profile).profile, task: task.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private loadTaskState(key: ConnectionKey): Map<string, Task> {
    const runtimeDir = getProfileRuntimeDir(key);
    const tasksFile = path.join(runtimeDir, 'tasks.json');

    if (!fs.existsSync(tasksFile)) {
      return new Map();
    }

    const state = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = new Map<string, Task>();
    let needsMigration = false;

    for (const [key, raw] of Object.entries(state)) {
      const task = raw as Record<string, unknown>;
      // Migrate old format (tabIds array) to new format (tabs object)
      if (Array.isArray(task.tabIds) && !task.tabs) {
        needsMigration = true;
        const tabs: Record<string, string> = {};
        for (const cdpId of task.tabIds as string[]) {
          const shortId = generateShortId();
          tabs[shortId] = cdpId;
        }
        const tabIds = Object.keys(tabs);
        tasks.set(key, {
          id: task.id as string,
          name: task.name as string || key,
          profile: asConnectionKey(task.profile as string),
          tabs,
          currentTabId: tabIds.length > 0 ? tabIds[tabIds.length - 1] : undefined,
          createdAt: task.createdAt as number,
          lastActionAt: (task.lastActionAt as number) ?? (task.createdAt as number),
          pid: task.pid as number,
        });
      } else {
        const loaded = task as unknown as Task;
        // Tasks persisted by older versions carry no lastActionAt. Normalize on
        // read so every in-memory task has one: its own createdAt is the last
        // moment we can prove the task did anything.
        if (typeof loaded.lastActionAt !== 'number') {
          loaded.lastActionAt = loaded.createdAt;
        }
        tasks.set(key, loaded);
      }
    }

    // Save migrated data back to disk
    if (needsMigration) {
      const migratedState = Object.fromEntries(tasks);
      fs.writeFileSync(tasksFile, JSON.stringify(migratedState, null, 2));
    }

    return tasks;
  }

  private async saveToHistory(task: Task, domains: string[]): Promise<void> {
    const historyDir = getBrowserRuntimeDir();
    await fs.promises.mkdir(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, 'history.json');

    let history: HistoricalTask[] = [];
    if (fs.existsSync(historyFile)) {
      try {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      } catch {
        // Corrupted file, start fresh
      }
    }

    history.unshift({
      id: task.id,
      name: task.name,
      // `task.profile` is the runtime key; history is a user-facing table, so
      // it carries the bare name.
      profile: parseConnectionKey(task.profile).profile,
      createdAt: task.createdAt,
      endedAt: Date.now(),
      domains,
      tabCount: Object.keys(task.tabs).length,
      ...(task.owner ? { owner: task.owner } : {}), // carry who launched it
    });

    // Keep only last 50 entries
    history = history.slice(0, 50);
    await fs.promises.writeFile(historyFile, JSON.stringify(history, null, 2));
  }

  /** Return the cached connection if live; evict sockets left behind by externally closed browsers. */
  private async reuseHealthyConnection(key: ConnectionKey): Promise<ProfileConnection | undefined> {
    const conn = this.connections.get(key);
    if (!conn) return undefined;
    if (await isConnHealthy(conn)) return conn;
    if (conn.backend === 'bidi') {
      try { conn.bidi.close(); } catch { /* already closed */ }
    } else if (conn.backend !== 'arc-native') {
      try { conn.cdp.close(); } catch { /* already closed */ }
    }
    conn.cleanup?.();
    this.connections.delete(key);
    emit('browser.connection_lost', { profile: conn.profile ?? parseConnectionKey(key).profile, backend: conn.backend });
    return undefined;
  }

  /** Reuse a live connection by device key first, then legacy endpoint keys, preserving existing
   * browsers. */
  private async reuseProfileConnection(
    profileName: ProfileName,
    preferred: ConnectionKey,
    local: boolean,
  ): Promise<{ conn: ProfileConnection; key: ConnectionKey } | undefined> {
    const preferredConn = await this.reuseHealthyConnection(preferred);
    if (preferredConn) return { conn: preferredConn, key: preferred };
    // Leftover `@endpoint-N` connections are THIS machine's pre-T2 local
    // browser. Reusing them on a tunnelled resolve is the original bug.
    if (!local) return undefined;

    for (const key of [...this.connections.keys()]) {
      if (key === preferred) continue;
      if (!isLegacyEndpointKey(key, profileName)) continue;
      if (parseConnectionKey(key).fork !== undefined) continue;
      const conn = await this.reuseHealthyConnection(key);
      if (conn) return { conn, key };
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Native Arc backend helpers
  // ---------------------------------------------------------------------------

  private arcAgentWindowPath(): string {
    return path.join(getBrowserServiceDir(), 'arc-agent-window.json');
  }

  private readArcAgentWindow(): (ArcAgentWindow & { retired: string[] }) | undefined {
    let saved: (Partial<ArcAgentWindow> & { retired?: unknown }) | null;
    try {
      saved = JSON.parse(fs.readFileSync(this.arcAgentWindowPath(), 'utf8'));
    } catch {
      return undefined;
    }
    if (typeof saved?.windowId !== 'string' || !saved.windowId || !Number.isInteger(saved.cgWindowId)) return undefined;
    const retired = Array.isArray(saved.retired) ? saved.retired.filter((id): id is string => typeof id === 'string') : [];
    return { windowId: saved.windowId, cgWindowId: saved.cgWindowId as number, retired };
  }

  /** The recorded agent window while it is still open, else a new one. The caller holds `arc-native:host-app`. */
  private async ensureArcAgentWindow(): Promise<ArcAgentWindow> {
    const recorded = this.readArcAgentWindow();
    if (recorded && await isArcAgentWindowLive(recorded)) return recorded;
    const opened = await openArcAgentWindow();
    const retired = recorded ? [recorded.windowId, ...recorded.retired].slice(0, 20) : [];
    const file = this.arcAgentWindowPath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify({ ...opened, retired }), { mode: 0o600 });
    await fs.promises.rename(`${file}.tmp`, file);
    return opened;
  }

  private async screenshotArcNative(
    conn: ArcProfileConnection,
    task: Task,
    runtimeKey: ConnectionKey,
    tabHint: string | undefined,
    outputPath: string | undefined,
    quality: 'compressed' | 'raw',
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const buffer = await this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const ref = this.requireArcTask(task).tabs[shortId];
      if (!ref) throw new Error(`Tab ${shortId} not found`);
      const agent = this.readArcAgentWindow();
      if (!agent || ref.windowId !== agent.windowId) {
        throw new ArcNativeCapabilityError(
          'screenshot',
          `Tab ${shortId} is not in the agent's Arc window (a task started before it existed opened in your own window, which is never captured). ` +
            'Start a new task: it opens in the agent\'s Arc window, which screenshot captures without bringing Arc forward.',
        );
      }
      return quality === 'raw'
        ? captureArcTab(ref, agent, { format: 'png' })
        : captureArcTab(ref, agent, { format: 'jpeg', qualities: [0.6, 0.3], maxBytes: 100 * 1024 });
    });
    return this.saveScreenshot(runtimeKey, task, shortId, buffer, quality === 'raw' ? 'png' : 'jpg', outputPath, quality);
  }

  /** Choose an Arc window and Space among `live`, preferring the frontmost window already showing
   * this profile. A task passes only the agent window's rows; `show` passes every other window. */
  private async resolveArcSpace(
    profile: ArcNativeProfileIdentity,
    live?: ArcEnumeratedSpace[],
  ): Promise<{ windowId: string; spaceId: string; spaceTitle: string }> {
    const picked = pickArcSpace(this.arcProfileSpaces(profile), live ?? await enumerateArcSpaces());
    if (picked) return picked;
    throw new Error(
      `No visible Arc window shows a Space of Arc profile ${JSON.stringify(profile.profileName)}. Open an Arc window.`,
    );
  }

  private arcProfileSpaces(profile: ArcNativeProfileIdentity): Array<{ id: string; title: string }> {
    const discovered = discoverArcProfiles();
    if (!discovered.ok) throw new Error(`Cannot read Arc profiles: ${discovered.reason}`);
    const found = discovered.profiles.find((candidate) => candidate.profileId === profile.profileId);
    if (!found) {
      throw new Error(
        `Arc profile ${JSON.stringify(profile.profileName)} (${profile.profileId}) no longer exists in Arc. ` +
          'Remove the row with `browser profiles prune`.',
      );
    }
    const own = found.spaces;
    if (own.length === 0) {
      throw new Error(`Arc profile ${JSON.stringify(profile.profileName)} has no Space. Add one in Arc's sidebar.`);
    }
    return own;
  }

  private requireArcTask(task: Task): NonNullable<Task['arcNative']> {
    const native = task.arcNative;
    if (!native || typeof native.profileId !== 'string' || typeof native.windowId !== 'string' ||
        typeof native.spaceId !== 'string' || !native.tabs || typeof native.tabs !== 'object') {
      throw new Error(`Task ${JSON.stringify(task.name)} has no valid durable Arc identity.`);
    }
    for (const [shortId, ref] of Object.entries(native.tabs)) {
      if (!ref || typeof ref.windowId !== 'string' || typeof ref.spaceId !== 'string' ||
          typeof ref.tabId !== 'string' || ref.windowId !== native.windowId || ref.spaceId !== native.spaceId) {
        throw new Error(
          `Owned Arc tab ${JSON.stringify(shortId)} has no stable id in its original window/Space.`,
        );
      }
    }
    for (const [shortId, intent] of Object.entries(native.createIntents ?? {})) {
      if (!intent || intent.tabId !== shortId || typeof intent.markerUrl !== 'string' ||
          !isArcCreateMarker(intent.markerUrl) ||
          typeof intent.targetUrl !== 'string' || typeof intent.createdAt !== 'number') {
        throw new Error(`Arc creation intent ${JSON.stringify(shortId)} is invalid; refusing recovery.`);
      }
      if (intent.ref && (intent.ref.windowId !== native.windowId || intent.ref.spaceId !== native.spaceId ||
          typeof intent.ref.tabId !== 'string')) {
        throw new Error(`Arc creation intent ${JSON.stringify(shortId)} left its original window/Space.`);
      }
    }
    return native;
  }

  private async reconcileArcCreateIntents(conn: ArcProfileConnection, task: Task): Promise<void> {
    const native = this.requireArcTask(task);
    for (const intent of Object.values(native.createIntents ?? {})) {
      let ref = intent.ref;
      if (ref) {
        const live = await resolveArcTab(ref);
        if (!live) {
          throw new Error(
            `Owned Arc tab ${intent.tabId} left its original window/Space while creation was incomplete; refusing to adopt it elsewhere.`,
          );
        }
        if (live.url === intent.targetUrl) {
          native.tabs[intent.tabId] = ref;
          task.tabs[intent.tabId] = ref.tabId;
          if (intent.previousTabId) {
            await restoreArcSelection(ref, intent.previousTabId);
          }
          delete native.createIntents?.[intent.tabId];
          await this.saveTaskState(task.profile, conn.tasks);
          continue;
        }
        if (live.url !== intent.markerUrl) {
          throw new Error(`Owned Arc tab ${intent.tabId} changed outside this task during creation; refusing to navigate it.`);
        }
      } else {
        const originalSpace = (await enumerateArcSpaces()).find(
          (space) => space.windowId === native.windowId && space.spaceId === native.spaceId,
        );
        if (!originalSpace) {
          throw new Error('The original Arc window/Space for this task is no longer present.');
        }
        const markerMatches = originalSpace.tabs.filter((tab) => tab.url === intent.markerUrl);
        if (markerMatches.length > 1) {
          throw new Error(`Arc creation marker ${JSON.stringify(intent.markerUrl)} is not unique in the original Space.`);
        }
        if (markerMatches[0]) {
          ref = markerMatches[0];
        } else {
          try {
            ref = await createArcTab({ windowId: native.windowId, spaceId: native.spaceId }, intent.markerUrl);
          } catch (error) {
            // Arc selects the Space it was asked to create in even when the
            // creation itself fails. Put the owner back on their tab before
            // surfacing the error, so a failed agent verb never leaves them
            // staring at the wrong Space.
            if (intent.previousTabId) {
              await selectWindowTab(native.windowId, intent.previousTabId).catch(() => undefined);
            }
            throw error;
          }
        }
        if (ref.windowId !== native.windowId || ref.spaceId !== native.spaceId) {
          // Never save a tab under another window or Space: requireArcTask would
          // reject the task on every later call, `stop` included.
          if (intent.previousTabId) {
            await selectWindowTab(native.windowId, intent.previousTabId).catch(() => undefined);
          }
          throw new Error(
            `Arc reported the new tab in window ${ref.windowId} / Space ${ref.spaceId}, not the task's ` +
              `${native.windowId} / ${native.spaceId}; nothing was saved.`,
          );
        }
        intent.ref = ref;
        native.tabs[intent.tabId] = ref;
        task.tabs[intent.tabId] = ref.tabId;
        await this.saveTaskState(task.profile, conn.tasks);
      }
      await navigateArcTab(ref, intent.targetUrl);
      if (intent.previousTabId) {
        // Warm JavaScript while the new Arc tab is selected: the first execute on a never-shown tab
        // blocks the full 15 s Apple Event timeout. The 2 s cap bounds how long the view is held.
        await executeJavaScript(ref, '0', 2_000).catch(() => undefined);
        await restoreArcSelection(ref, intent.previousTabId);
      }
      delete native.createIntents?.[intent.tabId];
      task.currentTabId = intent.tabId;
      await this.saveTaskState(task.profile, conn.tasks);
    }
  }

  private async createArcOwnedTab(
    conn: ArcProfileConnection,
    task: Task,
    url: string,
  ): Promise<string> {
    const native = this.requireArcTask(task);
    const tabId = generateShortId();
    const markerUrl = arcCreateMarker();
    const originalSpace = (await enumerateArcSpaces()).find(
      (space) => space.windowId === native.windowId && space.spaceId === native.spaceId,
    );
    if (!originalSpace) throw new Error('The original Arc window/Space for this task is no longer present.');
    native.createIntents ??= {};
    native.createIntents[tabId] = {
      tabId,
      markerUrl,
      targetUrl: url,
      createdAt: Date.now(),
      // Only a task opened in the owner's window, before the agent window existed, hands its tab back.
      previousTabId: native.agentWindow ? undefined : originalSpace.activeTabId,
    };
    await this.saveTaskState(task.profile, conn.tasks);
    await this.reconcileArcCreateIntents(conn, task);
    return tabId;
  }

  private async navigateArcNative(
    conn: ArcProfileConnection,
    task: Task,
    url: string,
    addTab = false,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    return this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const native = this.requireArcTask(task);
      if (!addTab) {
        for (const [shortId, ref] of Object.entries(native.tabs)) {
          const live = await resolveArcTab(ref);
          if (live && canonicalTabUrl(live.url) === canonicalTabUrl(url)) {
            await navigateArcTab(ref, url);
            task.currentTabId = shortId;
            await this.saveTaskState(task.profile, conn.tasks);
            return { tabId: shortId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
          }
        }
      }
      const currentId = task.currentTabId;
      if (!addTab && currentId) {
        const ref = native.tabs[currentId];
        if (!ref || !(await resolveArcTab(ref))) {
          throw new Error(`Owned Arc tab ${currentId} is missing from its original window/Space; refusing to adopt a moved tab.`);
        }
        await navigateArcTab(ref, url);
        return { tabId: currentId, url, created: false, refreshed: false };
      }
      const tabId = await this.createArcOwnedTab(conn, task, url);
      return { tabId, url, created: true, refreshed: false };
    });
  }

  /** Execute JavaScript in a native Arc tab. Sync JS only, isolated world —
   * async/promise evaluation fails honestly with an AppleScript error. */
  private async evaluateArcNative(
    conn: ArcProfileConnection,
    task: Task,
    shortId: string,
    expression: string,
  ): Promise<unknown> {
    const ref = this.requireArcTask(task).tabs[shortId];
    if (!ref || !(await resolveArcTab(ref))) {
      throw new Error(`Owned Arc tab ${shortId} is missing from its original window/Space.`);
    }
    return executeJavaScript(ref, expression);
  }

  /** Resolve owned Arc tabs from a shared snapshot, still requiring stable ids in the original window
   * and Space. */
  private async listArcTaskTabsFromSnapshot(
    task: Task,
    spaces: () => Promise<ArcEnumeratedSpace[]>,
  ): Promise<TabInfo[]> {
    // Before the snapshot on purpose: a ref naming a window its task does not
    // own is a moved tab on the record alone, so it needs no round trip and
    // reports the right reason even when Arc is unreachable.
    const native = this.requireArcTask(task);
    const snapshot = await spaces();
    const tabs: TabInfo[] = [];
    for (const [shortId, ref] of Object.entries(native.tabs)) {
      const live = snapshot
        .find((space) => space.windowId === ref.windowId && space.spaceId === ref.spaceId)
        ?.tabs.find((tab) => tab.tabId === ref.tabId);
      if (!live) {
        throw new Error(
          `Owned Arc tab ${shortId} is missing from its original window/Space; refusing to adopt a moved tab.`,
        );
      }
      tabs.push({
        id: shortId,
        url: live.url,
        title: live.title,
        task: task.name,
        current: shortId === task.currentTabId,
      });
    }
    return tabs;
  }

  private async listArcTaskTabs(task: Task): Promise<TabInfo[]> {
    const native = this.requireArcTask(task);
    const tabs: TabInfo[] = [];
    for (const [shortId, ref] of Object.entries(native.tabs)) {
      const live = await resolveArcTab(ref);
      if (!live) {
        throw new Error(
          `Owned Arc tab ${shortId} is missing from its original window/Space; refusing to adopt a moved tab.`,
        );
      }
      tabs.push({
        id: shortId,
        url: live.url,
        title: live.title,
        task: task.name,
        current: shortId === task.currentTabId,
      });
    }
    return tabs;
  }

  /** Close only created Arc tabs by stable ids in their original window/Space; never close borrowed
   * tabs or kill Arc. */
  private async closeArcNativeTabs(conn: ArcProfileConnection, task: Task): Promise<void> {
    await this.runExclusive('arc-native:host-app', async () => {
      const native = this.requireArcTask(task);
      // Closing never finishes an interrupted creation: reconciling would open
      // a tab and load the task's page in the owner's Arc only to close it. A
      // pending tab still showing its marker or target is ours and is closed;
      // one showing anything else, or gone, is left alone and forgotten.
      for (const intent of Object.values(native.createIntents ?? {})) {
        const refs = intent.ref
          ? [intent.ref]
          : (await enumerateArcSpaces())
              .filter((space) => space.windowId === native.windowId && space.spaceId === native.spaceId)
              .flatMap((space) => space.tabs.filter((tab) => tab.url === intent.markerUrl));
        for (const ref of refs) {
          const live = await resolveArcTab(ref);
          if (live && (live.url === intent.markerUrl || live.url === intent.targetUrl)) await closeArcTab(ref);
        }
        delete native.createIntents?.[intent.tabId];
      }
      for (const [shortId, ref] of Object.entries(native.tabs)) {
        await closeArcTab(ref);
        delete native.tabs[shortId];
        delete task.tabs[shortId];
        delete task.refDescriptors?.[shortId];
      }
      task.currentTabId = undefined;
    });
  }

  // ---------------------------------------------------------------------------
  // Firefox WebDriver BiDi backend helpers
  // ---------------------------------------------------------------------------

  /** The BiDi browsing-context id a task owns for `shortId`. */
  private firefoxContext(task: Task, shortId: string): string {
    const context = task.tabs[shortId];
    if (!context) throw new Error(`Tab ${shortId} not found`);
    return context;
  }

  /** The context ids currently live in this Firefox (a killed tab drops out). */
  private async firefoxLiveContexts(conn: FirefoxProfileConnection): Promise<Set<string>> {
    const contexts = await bidiTopLevelContexts(conn.bidi);
    return new Set(contexts.map((c) => c.context));
  }

  /** Reload an owned matching Firefox tab and return its retained short id; return undefined when none
   * matches. */
  private async reopenOwnedFirefoxTab(
    conn: FirefoxProfileConnection,
    task: Task,
    url: string,
  ): Promise<{ tabId: string } | undefined> {
    const borrowed = new Set(task.borrowedTabs ?? []);
    // Read URLs from the BiDi context tree so closed or navigating sibling tabs cannot fail unrelated
    // navigation.
    const liveUrlByContext = new Map(
      (await bidiTopLevelContexts(conn.bidi)).map((c) => [c.context, c.url]),
    );
    const wanted = canonicalTabUrl(url);
    for (const [shortId, context] of Object.entries(task.tabs)) {
      if (borrowed.has(shortId)) continue;
      const liveUrl = liveUrlByContext.get(context);
      if (liveUrl === undefined) continue; // registered but gone from the browser
      if (canonicalTabUrl(liveUrl) === wanted) {
        await bidiReload(conn.bidi, context);
        task.currentTabId = shortId;
        await this.saveTaskState(task.profile, conn.tasks);
        return { tabId: shortId };
      }
    }
    return undefined;
  }

  private async navigateFirefox(
    conn: FirefoxProfileConnection,
    task: Task,
    url: string,
    addTab = false,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    if (!addTab) {
      const reopened = await this.reopenOwnedFirefoxTab(conn, task, url);
      if (reopened) {
        emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: reopened.tabId, created: false });
        return { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
      }
      // Reuse the current tab when there is one — navigate() semantics.
      const currentShortId = task.currentTabId;
      if (currentShortId && task.tabs[currentShortId]) {
        const context = task.tabs[currentShortId];
        const live = await this.firefoxLiveContexts(conn);
        if (live.has(context)) {
          await bidiNavigate(conn.bidi, context, url);
          await this.saveTaskState(task.profile, conn.tasks);
          emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: currentShortId, created: false });
          return { tabId: currentShortId, url, created: false, refreshed: false };
        }
      }
    } else {
      const reopened = await this.reopenOwnedFirefoxTab(conn, task, url);
      if (reopened) {
        return { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
      }
    }
    // Open a fresh tab.
    const context = await bidiCreateTab(conn.bidi);
    await bidiNavigate(conn.bidi, context, url);
    const shortId = generateShortId();
    task.tabs[shortId] = context;
    task.currentTabId = shortId;
    await this.saveTaskState(task.profile, conn.tasks);
    emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: shortId, created: true });
    return { tabId: shortId, url, created: true, refreshed: false };
  }

  private async evaluateFirefox(
    conn: FirefoxProfileConnection,
    task: Task,
    shortId: string,
    expression: string,
  ): Promise<unknown> {
    const context = this.firefoxContext(task, shortId);
    const live = await this.firefoxLiveContexts(conn);
    if (!live.has(context)) throw new Error(`Tab ${shortId} is no longer open in Firefox.`);
    return bidiEvaluate(conn.bidi, context, expression);
  }

  private async listFirefoxTaskTabs(conn: FirefoxProfileConnection, task: Task): Promise<TabInfo[]> {
    const live = await bidiTopLevelContexts(conn.bidi);
    const byId = new Map(live.map((c) => [c.context, c]));
    const tabs: TabInfo[] = [];
    for (const [shortId, context] of Object.entries(task.tabs)) {
      const info = byId.get(context);
      if (!info) continue; // tab closed out from under the task — drop it silently.
      let title = '';
      try {
        title = String(await bidiEvaluate(conn.bidi, context, 'document.title'));
      } catch {
        /* about: pages or a mid-navigation context — url is enough */
      }
      tabs.push({ id: shortId, url: info.url, title, task: task.name, current: shortId === task.currentTabId });
    }
    return tabs;
  }

  /** Close non-borrowed Firefox task tabs, skipping vanished ones; never kill the browser and its other
   * tabs. */
  private async closeFirefoxTabs(conn: FirefoxProfileConnection, task: Task): Promise<void> {
    const borrowed = new Set(task.borrowedTabs ?? []);
    const live = await this.firefoxLiveContexts(conn);
    for (const [shortId, context] of Object.entries(task.tabs)) {
      if (borrowed.has(shortId)) continue;
      if (live.has(context)) {
        try { await bidiCloseTab(conn.bidi, context); } catch { /* already closed */ }
      }
    }
  }

  /** Scroll a Firefox selector into view and return its viewport center; throw for missing or zero-size
   * elements. */
  private async firefoxRefCoords(
    conn: FirefoxProfileConnection,
    task: Task,
    shortId: string,
    selector: string,
  ): Promise<{ x: number; y: number }> {
    const expr = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('DOM ref is missing');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) throw new Error('DOM ref has no layout box');
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`;
    const raw = await this.evaluateFirefox(conn, task, shortId, expr);
    const parsed = JSON.parse(String(raw)) as { x: number; y: number };
    return parsed;
  }

  /** Capture Firefox as pixel-faithful raw PNG or JPEG downscaled to the 100 KB budget. */
  private async screenshotFirefox(
    conn: FirefoxProfileConnection,
    task: Task,
    runtimeKey: ConnectionKey,
    tabHint: string | undefined,
    outputPath: string | undefined,
    quality: 'compressed' | 'raw',
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const context = this.firefoxContext(task, shortId);
    const live = await this.firefoxLiveContexts(conn);
    if (!live.has(context)) throw new Error(`Tab ${shortId} is no longer open in Firefox.`);

    let buffer: Buffer;
    let extension: 'png' | 'jpg';
    if (quality === 'raw') {
      buffer = await bidiScreenshot(conn.bidi, context, { type: 'image/png' });
      extension = 'png';
    } else {
      buffer = await bidiScreenshot(conn.bidi, context, { type: 'image/jpeg', quality: 0.7 });
      const MAX_SIZE = 100 * 1024;
      let q = 0.5;
      while (buffer.length > MAX_SIZE && q > 0.1) {
        buffer = await bidiScreenshot(conn.bidi, context, { type: 'image/jpeg', quality: q });
        q -= 0.1;
      }
      extension = 'jpg';
    }
    return this.saveScreenshot(runtimeKey, task, shortId, buffer, extension, outputPath, quality);
  }

  /** Serialize connect/register per runtime key so concurrent starts cannot replace connections holding
   * live tasks. */
  private async openConnection(
    profile: BrowserProfile,
    target: string,
    key: ConnectionKey,
    profileName: ProfileName,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection> {
    return this.runExclusive(`connect:${key}`, async () => {
      const existing = await this.reuseHealthyConnection(key);
      if (existing) return existing;
      const conn = await this.connectProfile(profile, target, key, opts);
      conn.key = key;
      conn.profile = profileName;
      this.connections.set(key, conn);
      // Download behavior configuration is CDP-specific; skip for native Arc + Firefox.
      if (conn.backend !== 'arc-native' && conn.backend !== 'bidi') {
        await this.applyDefaultDownloadBehavior(conn, key);
      }
      return conn;
    });
  }

  /** Open a user-owned viewer tab outside task tracking, so agent exit, reaping and done never close
   * it. An unowned tab already showing the page is reloaded and fronted instead, unless `fresh`;
   * `reused` says which. */
  async showUrl(
    profileName: ProfileName,
    url: string,
    opts: { endpointName?: string; fleetRemote?: boolean; actor?: string; probe?: DeviceProbe; fresh?: boolean } = {},
  ): Promise<{ profile: ProfileName; key: ConnectionKey; tabId: string; device: string; reused: boolean }> {
    // Same consent gate as start(): this opens a browser, so a fleet-remote
    // caller needs the target machine's opt-in.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });
    assertBrowserHomeReady();

    const routed = resolveBrowserTarget(profileName, {
      endpointName: opts.endpointName,
      probe: opts.probe,
    });
    if (!routed.local) throw peerProfileError(profileName, routed.device);
    const key = routed.key;
    const effectiveProfile: BrowserProfile = routed.profile;

    const reused = await this.reuseProfileConnection(profileName, key, routed.local);
    let conn = reused?.conn;
    const effectiveKey = reused?.key ?? key;
    if (!conn) {
      adoptLegacyRuntimeIfLocal(routed.local, profileName, key, getBrowserRuntimeDir());
      conn = await this.openConnection(
        effectiveProfile,
        routed.target,
        key,
        profileName,
        { persistRemote: !routed.local },
      );
    }

    if (conn.backend === 'bidi') {
      throw new FirefoxCapabilityError(
        'show',
        'Task-less viewer tabs are unavailable for a headless-automation Firefox profile. ' +
          'Use a Chromium-family profile, or open the URL in your OS browser.',
      );
    }

    const shown = conn.backend === 'arc-native'
      ? await this.showInArc(conn, url, opts.fresh === true)
      : await this.showInCdp(conn, url, opts.fresh === true);
    return {
      profile: profileName,
      key: effectiveKey,
      tabId: shown.tabId,
      device: routed.device,
      reused: shown.reused,
    };
  }

  /** The live page target no task owns that shows `url`, or undefined. */
  private findViewerTab<T extends { targetId: string; type: string; url: string }>(
    conn: ProfileConnection,
    url: string,
    targets: T[],
  ): T | undefined {
    return targets.find((t) => t.type === 'page' && !this.targetIsClaimed(conn, t.targetId) && sameShownPage(t.url, url));
  }

  private async showInCdp(conn: CdpProfileConnection, url: string, fresh: boolean): Promise<{ tabId: string; reused: boolean }> {
    return this.runExclusive(`show:${conn.key}`, async () => {
      if (!fresh) {
        const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
          targetInfos: Array<{ targetId: string; type: string; url: string }>;
        };
        const match = this.findViewerTab(conn, url, targetInfos);
        if (match) {
          const sessionId = await this.getSessionId(conn, match.targetId);
          // A task may have claimed the tab while the session attached; then it is the task's, not ours.
          if (!this.targetIsClaimed(conn, match.targetId)) {
            await conn.cdp.send('Page.navigate', { url }, sessionId);
            if (onlyFragmentMoves(match.url, url)) await this.reloadAfterFragmentMove(conn, sessionId, url);
            await conn.cdp.send('Target.activateTarget', { targetId: match.targetId });
            return { tabId: match.targetId, reused: true };
          }
        }
      }
      // createPageTarget refuses Arc with an actionable error rather than crashing it.
      const created = await this.createPageTarget(conn, { url });
      this.invalidateTargetCache(conn);
      return { tabId: created.targetId, reused: false };
    });
  }

  /** `Page.reload` before the browser commits the fragment move reloads the old URL; wait for it, bounded. */
  private async reloadAfterFragmentMove(conn: CdpProfileConnection, sessionId: string, url: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const { currentIndex, entries } = (await conn.cdp.send('Page.getNavigationHistory', {}, sessionId)) as {
        currentIndex: number;
        entries: Array<{ url: string }>;
      };
      if (entries[currentIndex]?.url === url) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await conn.cdp.send('Page.reload', {}, sessionId);
  }

  /** Native Arc: a tab no task owns in one of the profile's visible Spaces that shows
   * `url` is navigated to it and selected; otherwise a tab is created where a task's would be. */
  private async showInArc(conn: ArcProfileConnection, url: string, fresh: boolean): Promise<{ tabId: string; reused: boolean }> {
    return this.runExclusive('arc-native:host-app', async () => {
      const recorded = this.readArcAgentWindow();
      const agentWindows = new Set(recorded ? [recorded.windowId, ...recorded.retired] : []);
      const all = await enumerateArcSpaces();
      const others = all.filter((space) => !agentWindows.has(space.windowId));
      const live = others.length > 0 ? others : all;
      if (!fresh) {
        const own = new Set(this.arcProfileSpaces(conn.arcProfile).map((space) => space.id));
        const match = this.findViewerTab(
          conn,
          url,
          live.filter((space) => own.has(space.spaceId))
            .flatMap((space) => space.tabs.map((tab) => ({ ...tab, targetId: tab.tabId, type: 'page' }))),
        );
        if (match) {
          await navigateArcTab(match, url);
          if (onlyFragmentMoves(match.url, url)) await executeJavaScript(match, 'location.reload()');
          await selectArcTab(match, { activate: true });
          await confirmArcShows(match, url, match.url);
          return { tabId: match.tabId, reused: true };
        }
      }
      const space = pickShowSpace(this.arcProfileSpaces(conn.arcProfile), all, agentWindows)
        ?? await this.resolveArcSpace(conn.arcProfile, all);
      const created = await createArcTab(space, arcCreateMarker());
      try {
        await navigateArcTab(created, url);
        await selectArcTab(created, { activate: true });
        await confirmArcShows(created, url, created.url);
      } catch (error) {
        // No task owns this tab, so nothing would ever close a marker tab left behind.
        const message = error instanceof Error ? error.message : String(error);
        const cleanup = await closeArcTab(created).then(
          () => '',
          (closeError) => ` The new tab could not be closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
        throw new Error(`${message}${cleanup}`);
      }
      return { tabId: created.tabId, reused: false };
    });
  }

  async getHistory(limit = 10): Promise<HistoricalTask[]> {
    const historyFile = path.join(getBrowserRuntimeDir(), 'history.json');
    if (!fs.existsSync(historyFile)) return [];

    try {
      const history: HistoricalTask[] = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      return history.slice(0, limit);
    } catch {
      return [];
    }
  }
}
