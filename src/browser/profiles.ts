import * as path from 'path';
import * as fs from 'fs';
import {
  getBrowserRuntimeDir as getBrowserRuntimeDirRoot,
  getBrowserProfileRuntimeDir,
  getBrowserProfileDataDir,
  readMeta,
  updateMeta,
} from '../runtime/state.js';
import { getConfigValue } from '../runtime/device-config.js';
import type { BrowserProfileConfig } from '../runtime/types.js';
import type { BrowserProfile, ProfileName } from './types.js';
import { machineId } from '../runtime/machine-id.js';
import {
  declaringDevices,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';
import { findBrowserPath, isPortInUse } from './chrome.js';
import { arcProfileRows, arcSupportDir, discoverArcProfiles } from './arc-discovery.js';
import { discoverChromiumProfiles, discoverableChromiumBrowsers } from './chromium-discovery.js';
import { firefoxDiscoveredProfiles, discoverFirefoxProfiles } from './firefox-discovery.js';
import { discoverEditorWindows, editorWindowLabel } from './editor-discovery.js';

export type { BrowserProfile } from './types.js';
export {
  declaringDevices,
  profileKind,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';

/** Setup's concrete default profile name; separate from the reserved default alias resolved by
 * resolveProfileRef. */
export const DEFAULT_BROWSER_PROFILE_NAME = 'auto-chrome';

/** Recognize existing profiles under this legacy name to preserve their browser and runtime state. */
export const LEGACY_DEFAULT_BROWSER_PROFILE_NAME = 'default';

/** The configured-default alias; a literal profile named default still takes precedence for
 * compatibility. */
export const DEFAULT_PROFILE_ALIAS = 'default';

export type BrowserProfileWithDeclarations = BrowserProfile & { devices: string[] };

/** Return this device's browser.profile setting, used by bare start and the default alias. */
export function getConfiguredDefaultProfileName(): string | undefined {
  return (getConfigValue('browser.profile').value as string | undefined) || undefined;
}

export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

export function getProfileRuntimeDir(name: string): string {
  return getBrowserProfileRuntimeDir(name);
}

/** Arc is always attach-only because it is single-instance; other browsers require an explicit attach
 * policy. */
export function isAttachOnlyProfile(profile: Pick<BrowserProfile, 'browser' | 'launchPolicy'>): boolean {
  return profile.browser === 'arc' || profile.launchPolicy === 'attach-only';
}

/** Explicit stores win; otherwise sign-ins stay in the private logins directory. */
export function resolveProfileDataDir(profile: Pick<BrowserProfile, 'name' | 'userDataDir'>): string {
  if (profile.userDataDir) return profile.userDataDir;
  return getBrowserProfileDataDir(profile.name);
}

/** Return local Chromium login-store directories, or why unavailable; remote profiles keep stores on
 * their host. */
export function profileDataDirs(
  profile: BrowserProfile & { devices?: string[] },
  endpointName?: string,
): { dirs: string[] } | { reason: string } {
  if (profile.devices?.length && !profile.devices.includes(machineId())) {
    return { reason: `declared on ${profile.devices.join(', ')}, not this machine` };
  }
  const target = Object.keys(getEndpointPresets(profile)).length ? resolveEndpoint(profile, endpointName).target : '';
  if (target.startsWith('ssh://')) {
    return { reason: `browser runs on ${parseEndpointUrl(target)?.host ?? 'a remote host'} over ssh` };
  }
  if (profile.browser === 'firefox') return { reason: 'Firefox stores are not read' };
  if (profile.browser === 'editor') return { reason: 'an editor window keeps no login store of its own' };
  if (profile.browser === 'arc') {
    const arcDir = arcSupportDir();
    if (!arcDir) return { reason: 'Arc is not supported on this platform' };
    if (!profile.arc) return { reason: 'no Arc profile id recorded' };
    return { dirs: [path.join(arcDir, 'User Data', profile.arc.profileId)] };
  }
  if (profile.userDataDir) {
    return { dirs: [path.join(profile.userDataDir, profile.profileDirectory ?? 'Default')] };
  }
  if (isAttachOnlyProfile(profile)) return { dirs: [path.join(resolveProfileDataDir(profile), 'Default')] };
  const root = getBrowserRuntimeDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    /* no runtime dir yet */
  }
  const dirs = entries
    .filter((entry) => entry === profile.name || entry.startsWith(profile.name + '@'))
    .map((entry) => path.join(root, entry, 'chrome-data', 'Default'));
  return dirs.length ? { dirs } : { reason: 'never launched on this machine' };
}

/** Normalize data-dir ownership checks to the real path when available, otherwise strip trailing
 * slashes. */
export function normalizeDataDir(dir: string): string {
  let out = dir;
  try {
    out = fs.realpathSync(dir);
  } catch {
    /* dir may not exist on this box; compare the literal */
  }
  return out.replace(/\/+$/, '');
}

/** Return the profile's default download directory, keyed like its runtime directory. */
export function getProfileDownloadsDir(name: string): string {
  return path.join(getProfileRuntimeDir(name), 'downloads');
}

/** Return the per-profile task capture directory for screenshots, PDFs and recordings. */
export function getProfileSessionsDir(name: string, task: string): string {
  return path.join(getProfileRuntimeDir(name), 'sessions', task);
}

function configToProfile(
  name: string,
  config: BrowserProfileConfig,
  devices: string[] = [],
): BrowserProfileWithDeclarations {
  validateRemoteBrowserBinaries(config);
  return {
    name,
    description: config.description,
    browser: config.browser,
    binary: config.binary,
    electron: config.electron,
    targetFilter: config.targetFilter,
    endpoints: config.endpoints,
    defaultEndpoint: config.defaultEndpoint,
    launchPolicy: config.launchPolicy,
    userDataDir: config.userDataDir,
    profileDirectory: config.profileDirectory,
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
    // Only the identity: a declaration saved before profile rows existed still carries spaceId/spaceTitle.
    arc: config.arc && { profileId: config.arc.profileId, profileName: config.arc.profileName },
    firefox: config.firefox,
    devices,
  };
}

function profileToConfig(profile: BrowserProfile): BrowserProfileConfig {
  validateRemoteBrowserBinaries(profile);
  const config: BrowserProfileConfig = {
    browser: profile.browser,
    endpoints: profile.endpoints,
  };
  if (profile.description) config.description = profile.description;
  if (profile.binary) config.binary = profile.binary;
  if (profile.electron) config.electron = profile.electron;
  if (profile.targetFilter) config.targetFilter = profile.targetFilter;
  if (profile.defaultEndpoint) config.defaultEndpoint = profile.defaultEndpoint;
  if (profile.launchPolicy) config.launchPolicy = profile.launchPolicy;
  if (profile.userDataDir) config.userDataDir = profile.userDataDir;
  if (profile.profileDirectory) config.profileDirectory = profile.profileDirectory;
  if (profile.chrome) config.chrome = profile.chrome;
  if (profile.secrets) config.secrets = profile.secrets;
  if (profile.viewport) config.viewport = profile.viewport;
  if (profile.arc) config.arc = { profileId: profile.arc.profileId, profileName: profile.arc.profileName };
  if (profile.firefox) config.firefox = profile.firefox;
  return config;
}

/** Discover one row per native login identity; report torn source reads as errors without hiding other
 * browsers. */
export interface DiscoveredProfiles {
  profiles: BrowserProfileWithDeclarations[];
  /** Per-browser discovery failures, keyed by the profile-name prefix (`arc`, `comet`). */
  errors: Record<string, string>;
}

export function discoverNativeProfiles(): DiscoveredProfiles {
  const profiles: BrowserProfileWithDeclarations[] = [];
  const errors: Record<string, string> = {};
  const arc = discoverArcProfiles();
  if (arc.ok) {
    for (const row of arcProfileRows(arc)) {
      profiles.push({
        name: row.name,
        label: `Arc profile "${row.profileName}"`,
        browser: 'arc',
        endpoints: { native: { target: 'arc-native://local' } },
        defaultEndpoint: 'native',
        launchPolicy: 'attach-only',
        arc: { profileId: row.profileId, profileName: row.profileName },
        devices: [machineId()],
      });
    }
  } else if (arc.kind === 'invalid') {
    errors.arc = `Cannot discover Arc profiles: ${arc.reason}`;
  }
  // Ports handed out earlier in this pass: two unpublished profiles must never
  // derive the same port before either is declared.
  const reserved = new Set<number>();
  for (const browser of discoverableChromiumBrowsers()) {
    const found = discoverChromiumProfiles(browser);
    if (!found.ok) {
      if (found.kind === 'invalid') errors[browser] = `Cannot discover ${browser} profiles: ${found.reason}`;
      continue;
    }
    for (const native of found.profiles) {
      const port = nativeChromiumPort(native.name, reserved);
      reserved.add(port);
      profiles.push({
        name: native.name,
        label: `${browser.charAt(0).toUpperCase()}${browser.slice(1)} profile "${native.displayName}"`,
        browser,
        endpoints: [`cdp://127.0.0.1:${port}`],
        userDataDir: native.userDataDir,
        profileDirectory: native.profileDirectory,
        devices: [machineId()],
      });
    }
  }
  // Firefox: one profiles.ini entry is one `firefox-<slug>` profile,
  // pinned to that directory and a stable WebDriver BiDi port. Firefox dropped
  // CDP in 129, so these use a `firefox-bidi:` endpoint, not `cdp://`.
  const firefox = discoverFirefoxProfiles();
  if (firefox.ok) {
    for (const entry of firefoxDiscoveredProfiles(firefox)) {
      profiles.push({
        name: entry.name,
        label: `Firefox profile "${entry.profileName}"`,
        browser: 'firefox',
        endpoints: { bidi: { target: `firefox-bidi://127.0.0.1:${entry.port}` } },
        defaultEndpoint: 'bidi',
        userDataDir: entry.profileDir,
        firefox: {
          profileName: entry.profileName,
          iniPath: entry.iniPath,
          isDefault: entry.isDefault,
        },
        devices: [machineId()],
      });
    }
  } else if (firefox.kind === 'invalid') {
    errors.firefox = `Cannot discover Firefox profiles: ${firefox.reason}`;
  }
  const editors = discoverEditorWindows();
  if (editors.ok) {
    for (const w of editors.windows) {
      profiles.push({
        name: w.name,
        label: editorWindowLabel(w),
        browser: 'editor',
        endpoints: { editor: { target: `editor://${w.name}` } },
        defaultEndpoint: 'editor',
        launchPolicy: 'attach-only',
        devices: [machineId()],
      });
    }
  } else {
    errors.editor = `Cannot discover editor windows: ${editors.reason}`;
  }
  return { profiles, errors };
}

/** Allocate a discovered profile's CDP port, preserving declarations and excluding sibling
 * reservations. */
function nativeChromiumPort(name: string, reserved: ReadonlySet<number>): number {
  const declared = localDeclaration(name)?.config;
  const declaredPort = declared ? parseEndpointPort(declared) : undefined;
  if (declaredPort) return declaredPort;
  const taken = new Set<number>(reserved);
  for (const [other, declarations] of profileRegistry()) {
    if (other === name) continue;
    for (const declaration of declarations) {
      if (declaration.device !== machineId()) continue;
      const port = parseEndpointPort(declaration.config);
      if (port) taken.add(port);
    }
  }
  let port = 9333;
  while (taken.has(port)) port += 1;
  return port;
}

function parseEndpointPort(config: BrowserProfileConfig): number | undefined {
  const endpoints = config.endpoints;
  const first = Array.isArray(endpoints)
    ? endpoints[0]
    : endpoints && typeof endpoints === 'object'
      ? Object.values(endpoints)[0]?.target
      : undefined;
  if (typeof first !== 'string') return undefined;
  const match = /^cdp:\/\/[^:/?]+(?::(\d+)|\?port=(\d+))/.exec(first);
  const raw = match?.[1] ?? match?.[2];
  return raw ? Number(raw) : undefined;
}

function editorWindowNameOf(profile: BrowserProfile): string | undefined {
  const target = Object.values(getEndpointPresets(profile)).find((preset) => preset.target.startsWith('editor:'))?.target;
  return target ? new URL(target).hostname.toLowerCase() : undefined;
}

/** Return the native login identity, or undefined for profiles not pinned to a native store. */
export function nativeIdentity(profile: BrowserProfile): string | undefined {
  if (profile.arc) return `arc:${profile.arc.profileId}`;
  const editorName = editorWindowNameOf(profile);
  if (editorName) return `editor:${editorName}`;
  if (profile.userDataDir) return `${profile.browser}:${profile.userDataDir}:${profile.profileDirectory ?? ''}`;
  return undefined;
}

/** Refresh discovered metadata; retain the stored declaration when the source is no longer
 * discoverable. */
function refreshDiscoveredProfile(
  profile: BrowserProfileWithDeclarations,
  live: BrowserProfileWithDeclarations[],
): BrowserProfileWithDeclarations {
  if (!profile.devices.includes(machineId())) return profile;
  const identity = nativeIdentity(profile);
  if (!identity) return profile;
  const current = live.find((candidate) => nativeIdentity(candidate) === identity);
  if (!current) return profile;
  return { ...profile, arc: current.arc ?? profile.arc, label: current.label };
}

/** Return discovered logins not already saved under any name on this device. */
function unsavedNativeProfiles(discovered: BrowserProfileWithDeclarations[]): BrowserProfileWithDeclarations[] {
  const saved = new Set<string>();
  for (const [name, declarations] of profileRegistry()) {
    const here = declarations.find((declaration) => declaration.device === machineId());
    const identity = here && nativeIdentity(configToProfile(name, here.config));
    if (identity) saved.add(identity);
  }
  return discovered.filter((profile) => !saved.has(nativeIdentity(profile) ?? ''));
}

function selectedDeclaration(declarations: ProfileDeclaration[]): ProfileDeclaration {
  return declarations.find((declaration) => declaration.device === machineId()) ?? declarations[0];
}

function localDeclaration(name: string): ProfileDeclaration | undefined {
  return profileRegistry().get(name)?.find((declaration) => declaration.device === machineId());
}

/** Whether this name has persisted agents-cli metadata on the current device. */
export function isProfileDeclaredHere(name: string): boolean {
  return localDeclaration(name) !== undefined;
}

export async function listProfiles(): Promise<BrowserProfileWithDeclarations[]> {
  const native = discoverNativeProfiles();
  const configured = [...profileRegistry()].map(([name, declarations]) => {
    const selected = selectedDeclaration(declarations);
    return refreshDiscoveredProfile(
      configToProfile(name, selected.config, declarations.map((declaration) => declaration.device)),
      native.profiles,
    );
  });
  const names = new Set(configured.map((profile) => profile.name));
  return [...configured, ...unsavedNativeProfiles(native.profiles).filter((profile) => !names.has(profile.name))];
}

export async function getProfile(name: string): Promise<BrowserProfileWithDeclarations | null> {
  const native = discoverNativeProfiles();
  const declarations = profileRegistry().get(name);
  if (declarations?.length) {
    const selected = selectedDeclaration(declarations);
    return refreshDiscoveredProfile(
      configToProfile(name, selected.config, declarations.map((declaration) => declaration.device)),
      native.profiles,
    );
  }
  const discovered = unsavedNativeProfiles(native.profiles).find((profile) => profile.name === name) ?? null;
  // Only a profile of that browser asked for by name pays for its failed read.
  const prefix = name.split('-')[0];
  if (!discovered && native.errors[prefix]) throw new Error(native.errors[prefix]);
  return discovered;
}

/** Persist only the agents-cli alias for an auto-discovered native profile; never the browser's own data. */
export async function persistDiscoveredProfile(name: string): Promise<void> {
  if (localDeclaration(name)) return;
  const profile = unsavedNativeProfiles(discoverNativeProfiles().profiles).find((candidate) => candidate.name === name);
  if (!profile) return;
  await createProfile(profile);
}

/** Check local browser availability; SSH profiles defer that check to their remote host. */
export function isProfileLaunchableHere(profile: BrowserProfile): boolean {
  const nativeArc = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (nativeArc) {
    return !!profile.arc && discoverNativeProfiles().profiles.some(
      (candidate) => candidate.arc?.profileId === profile.arc?.profileId,
    );
  }
  const editorName = editorWindowNameOf(profile);
  if (editorName) {
    const editors = discoverEditorWindows();
    return editors.ok && editors.windows.some((w) => w.name === editorName);
  }
  const bidi = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('firefox-bidi:'),
  );
  if (bidi) {
    // Launchable here only when Firefox is installed AND this box holds the
    // pinned profile directory (a synced-in firefox- profile from another box
    // has that box's path, so it command-dispatches instead).
    if (!profile.userDataDir || !fs.existsSync(profile.userDataDir)) return false;
    try {
      findBrowserPath('firefox', profile.binary);
      return true;
    } catch {
      return false;
    }
  }
  const remote = Object.values(getEndpointPresets(profile)).some((preset) =>
    preset.target.startsWith('ssh://')
  );
  if (remote) return true;
  try {
    findBrowserPath(profile.browser, profile.binary);
    return true;
  } catch {
    return false;
  }
}

/** Find an existing auto-detected profile under either supported name without creating a duplicate. */
export async function getAutoDetectedProfile(): Promise<BrowserProfile | null> {
  const current = machineId();
  const registry = profileRegistry();
  for (const name of [DEFAULT_BROWSER_PROFILE_NAME, LEGACY_DEFAULT_BROWSER_PROFILE_NAME]) {
    const declaration = registry.get(name)?.find((entry) => entry.device === current);
    if (declaration) return configToProfile(name, declaration.config, [current]);
  }
  return null;
}

/** Resolve literal names before the default alias and existing auto-detected profiles; never create or
 * validate launchability. Pass a ref only when the user gave one: `undefined` means no filter, and
 * resolving it would silently narrow an unscoped listing. */
export async function resolveProfileRef(ref?: string): Promise<string | undefined> {
  if (ref && ref !== DEFAULT_PROFILE_ALIAS) {
    return ref;
  }
  if (ref === DEFAULT_PROFILE_ALIAS && (await getProfile(ref))) {
    // A profile the user literally named `default` outranks the alias.
    return ref;
  }

  const configured = getConfiguredDefaultProfileName();
  if (configured && configured !== DEFAULT_PROFILE_ALIAS && (await getProfile(configured))) {
    return configured;
  }
  if (await getProfile(DEFAULT_BROWSER_PROFILE_NAME)) return DEFAULT_BROWSER_PROFILE_NAME;
  if (await getProfile(LEGACY_DEFAULT_BROWSER_PROFILE_NAME)) {
    return LEGACY_DEFAULT_BROWSER_PROFILE_NAME;
  }
  return ref;
}

/** Resolve start's profile and validate implicit defaults locally; throw when no launchable default
 * resolves. */
export async function resolveProfileRefForStart(ref?: string): Promise<string> {
  if (ref && ref !== DEFAULT_PROFILE_ALIAS) return ref;
  // A profile the user literally named `default` still outranks the alias.
  if (ref === DEFAULT_PROFILE_ALIAS && (await getProfile(ref))) return ref;
  return (await ensureDefaultBrowserProfile()).name;
}

/** Return actionable setup guidance instead of silently creating a signed-out browser profile. */
export function noDefaultBrowserError(): Error {
  return new Error(
    'No default browser is configured on this machine. ' +
      'Run `browser use <name>` to pick the browser to drive, or `browser profiles create <name> --browser <type>` to add one. ' +
      'To drive another machine\'s browser, bind it when the task starts: `browser start --device <host>`.',
  );
}

/** Resolve a launchable configured or existing auto-detected default without creating one; undeclared
 * config throws. */
export async function ensureDefaultBrowserProfile(): Promise<BrowserProfile> {
  const configured = getConfiguredDefaultProfileName();
  if (configured && configured !== DEFAULT_PROFILE_ALIAS) {
    const chosen = await getProfile(configured);
    if (chosen && (!chosen.devices.includes(machineId()) || isProfileLaunchableHere(chosen))) return chosen;
    if (!chosen) {
      const central = (readMeta() as { browser?: Record<string, BrowserProfileConfig> }).browser ?? {};
      if (central[configured]) {
        throw new Error(
          `configured default browser profile "${configured}" is not declared by any device. ` +
            `It still lives in the central agents.yaml browser: map. ` +
            `Claim it on the machine that hosts that browser with: browser profiles claim ${configured}`,
        );
      }
      throw new Error(
        `configured default browser profile "${configured}" is not declared by any device. ` +
          `Create it with: browser profiles create ${configured} --browser <chrome|comet|chromium|brave|edge|arc|custom> ` +
          `(or, if it is a leftover central profile, claim it with: browser profiles claim ${configured}). ` +
          `Or unset the default with: browser use --unset`,
      );
    }
    console.warn(
      `warning: configured default browser profile "${configured}" can't launch on this ` +
        `machine (its browser/binary isn't installed here). ` +
        `Fix with: browser use <name>  (or --unset)`,
    );
  }

  // Prefer whichever auto-detected profile this machine already carries: the
  // current `auto-chrome`, else the `default` an older build wrote. Reusing the
  // legacy one is what keeps a currently-running browser (and its runtime dirs,
  // keyed `default@endpoint-0`) attached after the rename.
  const existing = await getAutoDetectedProfile();
  if (existing && isProfileLaunchableHere(existing)) return existing;

  // Do not silently create a signed-out browser; let the user choose the default.
  throw noDefaultBrowserError();
}

/** Return the local port claimed by CDP or SSH endpoints; SSH tunnels compete with local CDP listeners. */
export function effectiveLocalPort(profile: BrowserProfile): number | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  const target = presets[firstName].target;
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (url.protocol !== 'cdp:' && url.protocol !== 'ssh:') return undefined;
  return parseEndpointUrl(target)?.port;
}

/** Find an unclaimed, OS-free port in 9222–9399, including ports reserved by SSH profiles. */
export async function findFreeProfilePort(): Promise<number> {
  const profiles = await listProfiles();
  const usedByProfile = new Set<number>();
  for (const p of profiles) {
    const port = effectiveLocalPort(p);
    if (port !== undefined) usedByProfile.add(port);
  }

  for (let port = 9222; port <= 9399; port++) {
    if (usedByProfile.has(port)) continue;
    // Use the platform-aware probe; assuming lsof exists on Windows can misidentify occupied ports as
    // free.
    if (!isPortInUse(port)) return port;
  }

  throw new Error('No available ports in range 9222-9399');
}

function validateRemoteBrowserBinaries(
  profile: Pick<BrowserProfileConfig, 'binary' | 'endpoints'>
): void {
  if (!hasSshEndpoint(profile.endpoints)) return;
  validateRemoteBrowserBinary(profile.binary);
  if (!Array.isArray(profile.endpoints)) {
    for (const preset of Object.values(profile.endpoints)) {
      validateRemoteBrowserBinary(preset.binary);
    }
  }
}

function validateRemoteBrowserBinary(binary: string | undefined): void {
  if (!binary) return;
  if (/[\0\r\n;&|`$<>]/.test(binary)) {
    throw new Error(
      `Remote browser binary contains shell metacharacters: ${binary}`
    );
  }
}

export function hasSshEndpoint(endpoints: BrowserProfileConfig['endpoints']): boolean {
  const targets = Array.isArray(endpoints)
    ? endpoints
    : Object.values(endpoints).map((preset) => preset.target);
  return targets.some((target) => {
    try {
      return new URL(target).protocol === 'ssh:';
    } catch {
      return false;
    }
  });
}

/** Reject local-port conflicts across CDP and SSH profiles, excluding opts.ignore when editing a
 * profile. */
export function assertLocalPortFree(profile: BrowserProfile, opts: { ignore?: string } = {}): void {
  const wanted = effectiveLocalPort(profile);
  if (wanted === undefined) return;
  for (const [existingName, declarations] of profileRegistry()) {
    if (existingName === opts.ignore) continue;
    const declaration = declarations.find((entry) => entry.device === machineId());
    if (!declaration) continue;
    const existingProfile = configToProfile(existingName, declaration.config, [machineId()]);
    if (effectiveLocalPort(existingProfile) === wanted) {
      throw new Error(
        `Local port ${wanted} is already used by profile "${existingName}". ` +
          `Each profile must own a unique local port (SSH tunnels now bind ` +
          `to their configured port locally too). Pick a different port.`
      );
    }
  }
}

/** Declare a profile on this device. The same name may be declared by peers. */
export async function createProfile(profile: BrowserProfile): Promise<void> {
  if (localDeclaration(profile.name)) {
    throw new Error(`Profile "${profile.name}" already exists on ${machineId()}`);
  }

  assertLocalPortFree(profile);

  // Validate local binaries at creation; SSH binaries must be resolved on the remote host at connect
  // time.
  const nativeArc = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (nativeArc && (!profile.arc || profile.browser !== 'arc')) {
    throw new Error('An arc-native profile requires stable Arc profile metadata. Pick a discovered one from `browser profiles list`.');
  }
  const firefoxBidi = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('firefox-bidi:'),
  );
  if (firefoxBidi && (!profile.firefox || profile.browser !== 'firefox')) {
    throw new Error('A firefox-bidi profile requires a discovered Firefox profile. Pick one from `browser profiles list`.');
  }
  // Resolve discovered binaries at launch so one removed app cannot prevent other profiles from
  // publishing.
  const storePinned = !!profile.userDataDir && !!profile.profileDirectory;
  if (!hasSshEndpoint(profile.endpoints) && !nativeArc && !storePinned && profile.browser !== 'editor') {
    findBrowserPath(profile.browser, profile.binary);
  }

  const config = profileToConfig(profile);
  updateMeta((meta) => ({
    ...meta,
    deviceBrowser: { ...meta.deviceBrowser, [profile.name]: config },
  }));
}

export async function updateProfile(profile: BrowserProfile): Promise<void> {
  const local = localDeclaration(profile.name);
  if (!local) {
    const devices = declaringDevices(profile.name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${profile.name}" is not declared on ${machineId()}${where}`);
  }

  const config = profileToConfig(profile);
  updateMeta((meta) => ({
    ...meta,
    deviceBrowser: { ...meta.deviceBrowser, [profile.name]: config },
  }));
}

/** Editable settings exclude name and browser because they identify runtime state; use renameProfile
 * for renames. */
export type EditableProfileFields = Partial<
  Pick<
    BrowserProfile,
    | 'description'
    | 'binary'
    | 'electron'
    | 'targetFilter'
    | 'endpoints'
    | 'launchPolicy'
    | 'userDataDir'
    | 'chrome'
    | 'secrets'
    | 'viewport'
    | 'arc'
  >
>;

export interface EditProfileResult {
  profile: BrowserProfile;
  devices: string[];
  /** Field names that actually changed. Empty means the edit was a no-op. */
  changed: string[];
}

/** Validate the merged profile and persist it in its existing store, excluding its own port from
 * collisions. */
export async function editProfile(
  name: string,
  patch: EditableProfileFields
): Promise<EditProfileResult> {
  const local = localDeclaration(name);
  if (!local) {
    const devices = declaringDevices(name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${name}" is not declared on ${machineId()}${where}`);
  }

  const devices = declaringDevices(name);
  const current = configToProfile(name, local.config, devices);
  const merged: BrowserProfile = { ...current, ...patch, name };

  const changed = (Object.keys(patch) as Array<keyof EditableProfileFields>).filter(
    (k) => JSON.stringify(current[k]) !== JSON.stringify(merged[k])
  );

  // Validate targetFilter against the merged record: it requires Electron or Arc's existing-page reuse
  // path.
  if (merged.targetFilter && !merged.electron && merged.browser !== 'arc') {
    throw new Error(
      `--target-filter only applies to an Electron or Arc profile. ` +
        `Pass --electron, use --browser arc, or clear the filter with --target-filter ''.`
    );
  }

  assertLocalPortFree(merged, { ignore: name });

  // Same rule as create: the binary lives on the remote for an SSH profile, so a
  // local lookup would validate the wrong machine.
  const nativeArc = Object.values(getEndpointPresets(merged)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (!hasSshEndpoint(merged.endpoints) && !nativeArc) {
    findBrowserPath(merged.browser, merged.binary);
  }

  await updateProfile(merged);

  return {
    profile: merged,
    devices,
    changed,
  };
}

/** Profile names an agent has to be able to type and an fs path can hold. */
const PROFILE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Validate a new profile name, reserving default for the configured-default alias. */
export function assertRegistrableProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name ${JSON.stringify(name)}. Use lowercase letters, digits and hyphens, ` +
        `starting with a letter — e.g. 'agents'.`,
    );
  }
  if (name === DEFAULT_PROFILE_ALIAS) {
    throw new Error(
      `"${DEFAULT_PROFILE_ALIAS}" is the reserved alias for this machine's configured profile, ` +
        `not a profile name. Pick another name.`,
    );
  }
  // `browser.viewer: os` means "use the OS default handler". A profile by that
  // name turns the opt-out into a pointer at a profile — silently, since both
  // are just strings in the same key.
  if (name === 'os') {
    throw new Error(
      `"os" is the reserved browser.viewer value meaning the OS default handler, ` +
        `not a profile name. Pick another name.`,
    );
  }
}

/** Rename a profile with its on-disk state; refuse active profiles to avoid moving a live browser's
 * data directory. */
export async function renameProfile(
  from: ProfileName,
  to: ProfileName,
): Promise<{
  devices: string[];
  movedDirs: string[];
  repointedDefault: boolean;
  repointedViewer: boolean;
  /** Peers still pinning the OLD name, and which key each used. */
  stalePins: Array<{ device: string; key: 'browser.profile' | 'browser.viewer' }>;
}> {
  if (from === to) throw new Error(`"${from}" is already its own name.`);

  const local = localDeclaration(from);
  if (!local) {
    const devices = declaringDevices(from);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${from}" is not declared on ${machineId()}${where}`);
  }
  if (profileRegistry().has(to)) throw new Error(`Profile "${to}" already exists`);

  assertRegistrableProfileName(to);

  const { isProfileInUse, listProfileCacheDirs } = await import('./runtime-state.js');
  if (isProfileInUse(from)) {
    throw new Error(
      `"${from}" is in use (live browser, tunnel, or open task). Renaming would move its ` +
        `user-data-dir out from under the running browser. Stop it first: browser stop --profile ${from}`,
    );
  }

  const config = local.config;
  const devices = declaringDevices(from);

  // Preflight every destination before moving any state, then update config; a later collision must
  // not strand logins.
  const plan: Array<{ dir: string; dest: string }> = [];
  for (const dir of listProfileCacheDirs(from)) {
    const base = path.basename(dir);
    const suffix = base.slice(from.length);
    const dest = path.join(path.dirname(dir), `${to}${suffix}`);
    if (fs.existsSync(dest)) {
      throw new Error(
        `Cannot rename: ${dest} already exists. Nothing was moved. Remove or rename it first.`,
      );
    }
    plan.push({ dir, dest });
  }

  const movedDirs: string[] = [];
  for (const { dir, dest } of plan) {
    fs.renameSync(dir, dest);
    movedDirs.push(dest);
  }

  updateMeta((meta) => {
    const next = { ...meta.deviceBrowser };
    delete next[from];
    const privateBrowser = { ...meta.privateBrowser };
    if (Object.hasOwn(privateBrowser, from)) {
      delete privateBrowser[from];
      privateBrowser[to] = config;
    }
    return { ...meta, privateBrowser, deviceBrowser: { ...next, [to]: config } };
  });

  // Both pointers are separate keys. Leaving `browser.profile` behind falls back
  // to auto-detect on the next `browser start`; leaving `browser.viewer` behind
  // sends every artifact back to the OS default handler — which is the exact bug
  // the viewer seam was built to fix, reintroduced by a rename.
  const { setConfigValue, getConfigValue } = await import('../runtime/device-config.js');

  let repointedDefault = false;
  if (getConfiguredDefaultProfileName() === from) {
    setConfigValue('browser.profile', to);
    repointedDefault = true;
  }

  let repointedViewer = false;
  if (getConfigValue('browser.viewer').value === from) {
    setConfigValue('browser.viewer', to);
    repointedViewer = true;
  }

  // A rename changes only this device's declaration. If it was the only
  // declaration, peer pins become stale and are reported rather than rewritten.
  const { devicesPinningBrowserProfile } = await import('../runtime/device-config.js');
  const stalePins =
    devices.length === 1
      ? devicesPinningBrowserProfile(from).filter((p) => p.device !== machineId())
      : [];

  return { devices, movedDirs, repointedDefault, repointedViewer, stalePins };
}

export async function deleteProfile(name: string): Promise<void> {
  if (!localDeclaration(name)) {
    const devices = declaringDevices(name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${name}" is not declared on ${machineId()}${where}`);
  }

  updateMeta((meta) => {
    const next = { ...meta.deviceBrowser };
    delete next[name];
    return { ...meta, deviceBrowser: Object.keys(next).length > 0 ? next : undefined };
  });
}

/** Widest NAME column we will grow to before truncating instead. */
const MAX_NAME_COLUMN = 28;

/** Fit text to a fixed visible width, truncating overflow so later columns stay aligned. */
export function padColumn(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

/** Render profile rows without IO; mark the resolved default separately from literal profile names. */
export function formatProfilesTable(
  rows: BrowserProfileWithDeclarations[],
  configuredDefault?: string
): string[] {
  const cells = rows.map((profile) => {
    const presets = getEndpointPresets(profile);
    const endpoints = Object.entries(presets)
      .map(([name, ep]) => (name.startsWith('endpoint-') ? ep.target : `${name}=${ep.target}`))
      .join(', ');
    return {
      marker: profile.name === configuredDefault ? '*' : ' ',
      name: profile.name,
      browser: profile.browser || '-',
      where: profile.devices.join(', '),
      description: profile.description ?? profile.label ?? '',
      endpoints,
    };
  });

  const nameWidth = Math.min(
    MAX_NAME_COLUMN,
    Math.max('NAME'.length, ...cells.map((c) => c.name.length))
  );
  const browserWidth = Math.max('BROWSER'.length, ...cells.map((c) => c.browser.length));
  const whereWidth = Math.min(36, Math.max('WHERE'.length, ...cells.map((c) => c.where.length)));
  const hasDescriptions = cells.some((c) => c.description);
  const descWidth = hasDescriptions
    ? Math.min(36, Math.max('DESCRIPTION'.length, ...cells.map((c) => c.description.length)))
    : 0;

  const row = (
    marker: string,
    name: string,
    browser: string,
    where: string,
    desc: string,
    endpoints: string
  ): string =>
    `${marker} ` +
    padColumn(name, nameWidth) + '  ' +
    padColumn(browser, browserWidth) + '  ' +
    padColumn(where, whereWidth) + '  ' +
    (hasDescriptions ? padColumn(desc, descWidth) + '  ' : '') +
    endpoints;

  const header = row(' ', 'NAME', 'BROWSER', 'WHERE', 'DESCRIPTION', 'ENDPOINTS');
  const lines = [header, '-'.repeat(header.length)];
  for (const c of cells) {
    lines.push(row(c.marker, c.name, c.browser, c.where, c.description, c.endpoints));
  }
  if (configuredDefault) {
    lines.push('');
    lines.push(
      `* = this machine's default profile (${configuredDefault}) — what a bare \`browser start\` uses.`
    );
  }
  return lines;
}

/** Normalize endpoint presets, assigning endpoint-N names to legacy array entries. */
export function getEndpointPresets(
  profile: BrowserProfile
): Record<string, import('./types.js').EndpointPreset> {
  if (Array.isArray(profile.endpoints)) {
    const out: Record<string, import('./types.js').EndpointPreset> = {};
    profile.endpoints.forEach((target, i) => {
      out[`endpoint-${i}`] = { target };
    });
    return out;
  }
  return profile.endpoints;
}

/** Resolve explicit, default, then first endpoint; return its name and applied binary/targetFilter
 * overrides. */
export function resolveEndpoint(
  profile: BrowserProfile,
  endpointName?: string
): { name: string; target: string; binary?: string; targetFilter?: string } {
  const presets = getEndpointPresets(profile);
  const names = Object.keys(presets);
  if (names.length === 0) {
    throw new Error(`Profile "${profile.name}" has no endpoints configured`);
  }

  let chosenName: string;
  if (endpointName) {
    if (!presets[endpointName]) {
      throw new Error(
        `Endpoint "${endpointName}" not found on profile "${profile.name}". ` +
          `Available: ${names.join(', ')}`
      );
    }
    chosenName = endpointName;
  } else if (profile.defaultEndpoint && presets[profile.defaultEndpoint]) {
    chosenName = profile.defaultEndpoint;
  } else {
    chosenName = names[0];
  }

  const preset = presets[chosenName];
  return {
    name: chosenName,
    target: preset.target,
    binary: preset.binary ?? profile.binary,
    targetFilter: preset.targetFilter ?? profile.targetFilter,
  };
}

/** Return the default endpoint's host and port, accepting both URL-port and ?port=N forms. */
export function extractConfiguredEndpoint(
  profile: BrowserProfile
): { host: string; port: number } | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  return parseEndpointUrl(presets[firstName].target);
}

/** Parse endpoint host and port consistently for collision checks and connection drivers. */
export function parseEndpointUrl(
  endpoint: string
): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  const host = normalizeHost(url.hostname, url.protocol);
  if (!host) return undefined;
  const port = extractPortFromUrl(url);
  if (port !== undefined) return { host, port };
  // SSH endpoints tunnel to a remote port AND bind that same port locally,
  // so they do "own" a local port — the host-scoped collision check used
  // to disagree, but we want the local-port-scoped semantics now.
  if (url.protocol === 'cdp:' || url.protocol === 'ssh:') return { host, port: 9222 };
  return undefined;
}

function extractPortFromUrl(url: URL): number | undefined {
  if (url.port) {
    const n = parseInt(url.port, 10);
    if (Number.isFinite(n)) return n;
  }
  // `scheme://host?port=N` — the form documented for SSH endpoints in
  // `types.ts`. WHATWG URL parsing surfaces it via searchParams only.
  const qp = url.searchParams.get('port');
  if (qp) {
    const n = parseInt(qp, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Return the default endpoint's port, or undefined; use the full endpoint when host identity matters. */
export function extractConfiguredPort(profile: BrowserProfile): number | undefined {
  return extractConfiguredEndpoint(profile)?.port;
}

function normalizeHost(hostname: string, protocol: string): string | undefined {
  if (!hostname) {
    // cdp:// and ssh:// without an explicit host imply localhost.
    if (protocol === 'cdp:' || protocol === 'ssh:') return '127.0.0.1';
    return undefined;
  }
  if (hostname === 'localhost') return '127.0.0.1';
  return hostname;
}
