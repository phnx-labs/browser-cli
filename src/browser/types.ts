import type { ArcNativeTabRef } from './drivers/arc.js';

export type { ArcNativeTabRef } from './drivers/arc.js';

export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'firefox' | 'custom';

/** Connection transport discriminant; actions must route non-CDP backends to their drivers or throw
 * capability errors. */
export type BackendKind = 'cdp' | 'arc-native' | 'bidi';

/** An Arc profile identifies shared logins; each task chooses and records its own Space separately. */
export interface ArcNativeProfileIdentity {
  /** Arc's profile directory basename. Authoritative id. */
  profileId: string;
  /** Display-only Arc profile name from Local State. Never used for addressing. */
  profileName: string;
}

/** A crash-safe native create intent persisted before Arc is asked to mutate. */
export interface ArcNativeCreateIntent {
  tabId: string;
  markerUrl: string;
  targetUrl: string;
  createdAt: number;
  /** Active tab before creation, restored only if the owned tab stayed active. */
  previousTabId?: string;
  /** Written immediately after the driver returns, before final navigation. */
  ref?: ArcNativeTabRef;
}

/** Durable Arc state owned by one browser task. */
export interface ArcNativeTaskState {
  profileId: string;
  /** Original Arc window id. A tab moved elsewhere is never adopted. */
  windowId: string;
  spaceId: string;
  /** Display-only snapshot for status output. */
  spaceTitle: string;
  tabs: Record<string, ArcNativeTabRef>;
  createIntents?: Record<string, ArcNativeCreateIntent>;
  agentWindow?: boolean;
}

/** Bare user-facing profile name, without endpoint or fork suffixes. */
export type ProfileName = string;

/**
 * The key of an endpoint preset within a profile (`endpoint-0`, `local`, …) —
 * see {@link EndpointPreset} and `getEndpointPresets`.
 */
export type EndpointName = string;

/** Branded runtime key for connections and disk state; derive with connectionKey, adopt existing keys
 * with asConnectionKey. */
export type ConnectionKey = string & { readonly __connectionKey: unique symbol };

/** The single site that derives a {@link ConnectionKey} from its two parts. */
export function connectionKey(profile: ProfileName, endpoint: EndpointName): ConnectionKey {
  return `${profile}@${endpoint}` as ConnectionKey;
}

/** Adopt an existing runtime key; derive keys from bare profile names with connectionKey instead. */
export function asConnectionKey(raw: string): ConnectionKey {
  return raw as ConnectionKey;
}

/** Split a runtime key; without @, preserve the whole legacy profile name so chrome.2 cannot be
 * mistaken for a fork. */
export function parseConnectionKey(key: string): {
  profile: ProfileName;
  endpoint?: EndpointName;
  fork?: number;
} {
  // LAST `@`, not the first: a profile name may itself contain one (`me@work`),
  // and splitting on the first would report its profile as `me` — so
  // `status --profile me@work` would find nothing for a running browser.
  const at = key.lastIndexOf('@');
  if (at === -1) return { profile: key };
  const profile = key.slice(0, at);
  const rest = key.slice(at + 1);
  const dot = rest.indexOf('.');
  if (dot === -1) return { profile, endpoint: rest };
  const fork = Number(rest.slice(dot + 1));
  return {
    profile,
    endpoint: rest.slice(0, dot),
    fork: Number.isFinite(fork) ? fork : undefined,
  };
}

/** True when `key` is a runtime key of `profile`. The only reconciliation rule. */
export function keyBelongsToProfile(key: string, profile: ProfileName): boolean {
  return parseConnectionKey(key).profile === profile;
}

/** Named endpoint preset whose overrides take precedence over profile fields. */
export interface EndpointPreset {
  /** CDP or SSH endpoint URL; ?os=windows selects Windows remote launch/teardown, otherwise SSH uses
   * POSIX. */
  target: string;
  /** Override the profile-level binary (e.g. a remote host has no local binary). */
  binary?: string;
  /** Override the profile-level targetFilter (Electron app builds may diverge). */
  targetFilter?: string;
}

export interface BrowserProfile {
  /** Bare user-facing name; endpoint-bearing runtime keys must stay in ConnectionKey fields. */
  name: ProfileName;
  /** A note a person wrote. Discovery never generates one. */
  description?: string;
  /**
   * What a discovered row stands for (`Arc profile "Work"`), derived from the
   * browser on every read and never persisted, so it cannot go stale.
   */
  label?: string;
  browser: BrowserType;
  binary?: string;
  electron?: boolean;
  /**
   * `url:<substring>` or `title:<substring>`. Picks which CDP page target
   * represents the visible UI for Electron apps with multiple WebContents.
   */
  targetFilter?: string;
  /** Legacy URL arrays or named endpoint presets; normalize through resolveEndpoint instead of reading
   * directly. */
  endpoints: string[] | Record<string, EndpointPreset>;
  defaultEndpoint?: string;
  /** Launch when needed, or attach-only with a relaunch hint if unavailable; Arc must never spawn a
   * rival instance. */
  launchPolicy?: 'attach-only' | 'launch';
  /** Durable user-data directory used for ownership verification; resolve defaults through
   * resolveProfileDataDir. */
  userDataDir?: string;
  /** Chromium profile directory inside `userDataDir` for a discovered native profile (PHNX-4042). */
  profileDirectory?: string;
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number; x?: number; y?: number };
  /** Native Arc identity. Present only for an `arc-native:` profile. */
  arc?: ArcNativeProfileIdentity;
  /** Discovered Firefox profile identity; userDataDir carries the directory passed to Firefox's
   * --profile. */
  firefox?: FirefoxProfileIdentity;
}

/** Stable Firefox login-store identity discovered from profiles.ini. */
export interface FirefoxProfileIdentity {
  /** The `Name=` of the `[ProfileN]` section. Display + slug source only. */
  profileName: string;
  /** The `profiles.ini` the entry was read from. Display only. */
  iniPath: string;
  /** Whether `profiles.ini` marks the entry `Default=1`. Display only. */
  isDefault: boolean;
}

/** Parsed form of `BrowserProfile.targetFilter`. */
export interface TargetFilter {
  kind: 'url' | 'title';
  value: string;
}

export interface ChromeOptions {
  headless?: boolean;
  args?: string[];
  viewport?: { width: number; height: number; x?: number; y?: number };
  /** The browser's own user-data dir; set only for a discovered native profile (PHNX-4042). */
  userDataDir?: string;
  /** Chromium profile directory inside `userDataDir` (`Default`, `Profile 1`, ...). */
  profileDirectory?: string;
}

export interface Task {
  id: string;
  /** Addressable task handle and storage key; explicit task names override generated short ids. */
  name: string;
  /** Readable status label, separate from the addressable handle; derived from title, initial host or
   * untitled. */
  label?: string;
  /** Runtime connection key for this task's persisted state and captures; parse it to recover the bare
   * profile name. */
  profile: ConnectionKey;
  /** shortId -> CDP target id, or native tab id mirrored from arcNative.tabs. */
  tabs: Record<string, string>;
  /** Short ids of tabs driven but not created by the task; every close path must leave them open. */
  borrowedTabs?: string[];
  currentTabId?: string; // shortId of current tab
  createdAt: number;
  /** Persisted last-use time for idle reaping; old records normalize missing values to createdAt. */
  lastActionAt: number;
  pid: number;
  /** Caller actor id, forwarded at start because the shared daemon cannot resolve the caller's
   * identity. */
  owner?: string;
  /** Caller run id, distinct from actor identity; scopes current-task defaults and status --mine. */
  launchId?: string;
  /** Calling session id in live task state; durable browser session history survives task stop. */
  sessionId?: string;
  /**
   * Started over `--device` from another machine. Its session runs there, so
   * this host's process table cannot witness it and only the idle rule reaps it.
   */
  fleetRemote?: true;
  /** Persisted per-tab ref descriptors and numbering options; only refs() writes them, actions use them
   * to heal drift. */
  refDescriptors?: Record<string, import('./refs.js').RefSnapshot>;
  /** Durable stable native ids and crash-intent ledger for an Arc task. */
  arcNative?: ArcNativeTaskState;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  task: string;
  /** Whether this is the task's current tab (the one URL-less verbs act on). */
  current?: boolean;
}

/** Profile tab row: task-owned tabs use task handles/short ids; other tabs expose browser ids without a
 * task. */
export interface ProfileTabInfo {
  id: string;
  url: string;
  title: string;
  task?: string;
  /** The queried task's current tab. */
  current?: boolean;
}

export interface ProfileStatus {
  /** Bare profile name for display; endpoint and runtime key are reported separately. */
  name: ProfileName;
  /** Endpoint preset this browser is running at, when the key carries one. */
  endpoint?: EndpointName;
  /** The runtime key backing this status: `<profile>@<endpoint>[.<fork>]`. */
  key?: ConnectionKey;
  running: boolean;
  port?: number;
  pid?: number;
  /** The port declared in the profile's first endpoint, when it differs from the running port. */
  configuredPort?: number;
  tasks: TaskStatus[];
  /** Live-read failure details; retain known disk state without hiding other profiles or claiming the
   * read succeeded. */
  unavailable?: string;
}

export interface TaskStatus {
  id: string;
  name: string;
  /** Human label for status tables; falls back to name when absent. */
  label?: string;
  tabCount: number;
  currentTabId?: string;
  createdAt: number;
  endedAt?: number;
  domains?: string[];
  tabs?: Array<{ id: string; url: string; title?: string; current?: boolean; task?: string }>;
  /** Enumeration failure with tabs absent; recorded tabCount reports disk ownership, not verified live
   * tabs. */
  unavailable?: string;
}

export interface HistoricalTask {
  id: string;
  name: string;
  profile: string;
  createdAt: number;
  endedAt: number;
  domains: string[];
  tabCount: number;
  /** Actor id who launched the task (RUSH-2020); absent for pre-RUSH-2020 history. */
  owner?: string;
}

/** Reaper reason: a provably dead owner or inactivity beyond the idle window. */
export type ReapReason = 'session-dead' | 'idle';

/** One task the reaper stopped (or, under `dryRun`, would have stopped). */
export interface ReapedTask {
  task: string;
  profile: string;
  reason: ReapReason;
}

export interface ReapResult {
  closed: ReapedTask[];
  /** Tasks left alone this pass: still live, still inside the idle window, or recording. */
  skipped: number;
  /** Reapable tasks whose close threw; the rest of the pass still ran. */
  failed: Array<{ task: string; profile: string; error: string }>;
}

export type IPCAction =
  | 'start'
  // Open a tab for a HUMAN to read. Deliberately absent from PAGE_CREATE_VERBS
  // and PAGE_RESOLVE_VERBS: it must NOT bind a task, or the abandoned-task
  // reaper would close the user's tab when the calling session ends.
  | 'show'
  | 'gc'
  | 'record-start'
  | 'record-stop'
  | 'done'
  | 'stop'
  | 'status'
  | 'history'
  | 'navigate'
  | 'tab-add'
  | 'tab-focus'
  | 'tab-close'
  | 'tab-list'
  | 'evaluate'
  | 'text'
  | 'screenshot'
  | 'pdf'
  | 'refs'
  | 'click'
  | 'type'
  | 'select'
  | 'press'
  | 'dialog'
  | 'hover'
  | 'scroll'
  | 'set-viewport'
  | 'set-device'
  | 'console'
  | 'errors'
  | 'requests'
  | 'response-body'
  | 'wait'
  | 'set-download-path'
  | 'wait-download'
  | 'upload'
  | 'version';

export interface IPCRequest {
  action: IPCAction;
  task?: string;
  taskName?: string; // human-readable task name for 'open'
  /** tab-list: every tab open in the profile browser, not only the task's own. */
  all?: boolean;
  profile?: string;
  url?: string;
  tabId?: string;
  expr?: string;
  path?: string;
  ref?: number;
  /** `type` and `select` by the element's accessible name instead of a ref. */
  name?: string;
  /** `text --css`: each element the selector matches instead of the whole page; `attr` reads that attribute. */
  css?: string;
  attr?: string;
  // Coordinate click (`browser click --at X,Y`): bypasses ref resolution.
  atX?: number;
  atY?: number;
  text?: string;
  /** `click --text … --role <role>`: only elements of this accessibility role. */
  role?: string;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  scrollAtX?: number;
  scrollAtY?: number;
  interactive?: boolean;
  limit?: number;
  /** Return the settled page's URL, title and fresh interactive refs alongside the action result. */
  snapshot?: boolean;
  /** The same actions settle before answering unless this is false (`--no-wait`). */
  wait?: boolean;
  // Viewport/device
  width?: number;
  height?: number;
  deviceName?: string;
  mobile?: boolean;
  deviceScaleFactor?: number;
  // Console/errors
  level?: 'log' | 'info' | 'warn' | 'error';
  clear?: boolean;
  // Network
  filter?: string;
  urlPattern?: string;
  maxChars?: number;
  // Wait
  waitType?: 'time' | 'selector' | 'url' | 'function' | 'load';
  waitValue?: string | number;
  timeout?: number;
  // Downloads
  downloadPath?: string;
  // Upload
  files?: string[];
  trigger?: number;
  uploadMode?: 'auto' | 'input' | 'drop' | 'chooser';
  // Screenshot
  quality?: 'compressed' | 'raw';
  // Endpoint preset
  endpoint?: string;
  // Recording
  fps?: number;
  duration?: number;
  maxMb?: number;
  /**
   * Explicit human label for a new task (`browser start --title …`).
   * When omitted, the label is derived from the first navigated host.
   */
  title?: string;
  /** start: skip abandoned-task tab adoption and open fresh (user and live-task tabs are never
   * adopted). show: open a new tab even when one already shows the page. */
  fresh?: boolean;
  // `gc`: override the idle window (default 30) and preview without closing.
  idleMinutes?: number;
  dryRun?: boolean;
  // Forward caller actor/run identity; the shared daemon's own identity cannot identify the request.
  actor?: string;
  launchId?: string;
  /** Primary caller session identity, forwarded from the environment and persisted in browser session
   * history. */
  sessionId?: string;

  /** Per-request fleet dispatch marker; the long-lived daemon's inherited environment cannot identify
   * the current caller. */
  fleetRemote?: boolean;

  /** Server-derived first-open result prevents duplicate navigation; bindTask discards client-supplied
   * values. */
  firstOpen?: PageOpenResult;
}

/** The page an action left behind, returned by --snapshot. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Interactive ref listing, numbered exactly as a following `browser refs` would be. */
  refs: string;
}

/** Created and refreshed are exclusive; adoption or navigation of an existing tab sets neither. */
export interface PageOpenResult {
  tabId?: string;
  created: boolean;
  refreshed: boolean;
  message?: string;
}

export interface IPCResponse {
  ok: boolean;
  error?: string;
  /** Page dialogs (alert, confirm, prompt, beforeunload) the service accepted for this task since its last reply. */
  dialogs?: string[];
  task?: string;
  tabId?: string;
  /** True only when a new page target opened; reloading an owned matching tab reports refreshed
   * instead. */
  created?: boolean;
  /** An owned matching tab reloaded in place, keeping its id (show: an unowned one); mutually
   * exclusive with created. */
  refreshed?: boolean;
  /** Task-level named-start reuse; a no-URL retry performs no page refresh. */
  reused?: boolean;
  windowTargetId?: string;
  /** `tab-list` rows; `task` is absent for a tab no agents-cli task owns (`--all`). */
  tabs?: ProfileTabInfo[];
  profiles?: ProfileStatus[];
  history?: HistoricalTask[];
  /** `gc`: what the abandoned-task reaper closed (or would close under dryRun). */
  reaped?: ReapResult;
  result?: unknown;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  refs?: string;
  nodes?: RefNodeJson[];
  /** `--snapshot`: the page an action left behind. */
  snapshot?: PageSnapshot;
  /** Human-readable note surfaced to the CLI (e.g. a self-heal notice on click). */
  message?: string;
  port?: number;
  pid?: number;
  // Recording
  fps?: number;
  durationCapSec?: number;
  maxMb?: number;
  durationMs?: number;
  stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  // Console/errors
  logs?: ConsoleEntry[];
  errors?: ErrorEntry[];
  // Network
  requests?: NetworkRequest[];
  body?: string;
  // Downloads
  downloadPath?: string;
  // Devices
  devices?: string[];
  // Upload
  uploadMode?: 'input' | 'drop' | 'chooser';
  // Report the daemon's build version so older daemons can be identified during the client handshake.
  version?: string;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
}

export interface RefNodeJson {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  editor?: string;
}

export interface DeviceDescriptor {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_REGEX.test(id) && id.length <= 64;
}

export function generateTaskId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function generateShortId(): string {
  return crypto.randomUUID().split('-')[0]; // 8 chars
}
