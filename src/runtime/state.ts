import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import lockfile from 'proper-lockfile';
import { machineId } from './machine-id.js';
import type { BrowserProfileConfig, Meta } from './types.js';

export function getAgentsHome(): string {
  return process.env.AGENTS_HOME ?? path.join(process.env.HOME || os.homedir(), '.agents');
}

export function getUserAgentsDir(): string {
  return getAgentsHome();
}

export function getHistoryDir(): string {
  return process.env.AGENTS_HISTORY_DIR ?? path.join(getAgentsHome(), '.history');
}

export function getBrowserHome(): string {
  return path.join(getAgentsHome(), 'browser');
}

export function getBrowserRuntimeDir(): string { return path.join(getBrowserHome(), 'cache'); }
export function getBrowserDurableDir(): string { return path.join(getBrowserHome(), 'logins'); }
export function getBrowserServiceDir(): string { return path.join(getBrowserHome(), 'run'); }
export function getBrowserServicePidPath(): string { return path.join(getBrowserServiceDir(), 'service.pid'); }
export function getBrowserServiceLockPath(): string { return path.join(getBrowserServiceDir(), 'serve.lock'); }
export function getBrowserSocketPath(): string { return path.join(getBrowserServiceDir(), 'browser.sock'); }
export function getBrowserLogsDir(): string { return path.join(getBrowserHome(), 'logs'); }
export function getBrowserServiceLogPath(): string { return path.join(getBrowserLogsDir(), 'browser-service.log'); }
export function getBrowserActionsDir(): string { return path.join(getBrowserLogsDir(), 'actions'); }
export function getBrowserDaemonLogPath(): string { return path.join(getBrowserLogsDir(), 'daemon.jsonl'); }
export function getBrowserDataDir(): string { return path.join(getBrowserHome(), 'data'); }
export function getBrowserHistoryPath(): string { return path.join(getBrowserDataDir(), 'history.db'); }
export function getBrowserProfilesDir(): string { return path.join(getBrowserHome(), 'profiles'); }
export function getBrowserProfilesPath(device = machineId()): string { return path.join(getBrowserProfilesDir(), `${device}.yaml`); }
export function getBrowserLocalDir(): string { return path.join(getBrowserHome(), 'local'); }
export function getBrowserLocalProfilesPath(): string { return path.join(getBrowserLocalDir(), 'profiles.yaml'); }
export function getBrowserSettingsPath(): string { return path.join(getBrowserLocalDir(), 'settings.yaml'); }
// Legacy moves must stay inside AGENTS_HOME despite inherited Agents directory overrides.
export function getLegacyBrowserServiceDir(): string { return path.join(getAgentsHome(), '.cache', 'helpers', 'browser'); }
export function getLegacyBrowserSocketPath(): string { return path.join(getLegacyBrowserServiceDir(), 'browser.sock'); }
export function getLegacyBrowserPidPath(): string { return path.join(getLegacyBrowserServiceDir(), 'service.pid'); }
export function getLegacyBrowserRuntimeDir(): string { return path.join(getAgentsHome(), '.cache', 'browser'); }
export function getLegacyBrowserActionsDir(): string { return path.join(getLegacyBrowserRuntimeDir(), 'actions'); }
export function getLegacyBrowserDurableDir(): string { return path.join(getAgentsHome(), '.history', 'browser-profiles'); }
export function getBrowserMigrationMarkerPath(): string { return path.join(getBrowserLocalDir(), 'home-migrated'); }
export function getBrowserMigrationLockPath(): string { return path.join(getBrowserLocalDir(), 'migration.lock'); }
export function getBrowserConflictDir(): string { return path.join(getBrowserLocalDir(), 'migration-conflicts'); }

export function browserStateMoves(): Array<[string, string]> {
  return [
    [getLegacyBrowserRuntimeDir(), getBrowserRuntimeDir()],
    [path.join(getAgentsHome(), '.history', 'browser'), getBrowserDataDir()],
    [getLegacyBrowserDurableDir(), getBrowserDurableDir()],
    [getLegacyBrowserServiceDir(), getBrowserServiceDir()],
    [path.join(getAgentsHome(), '.cache', 'logs', 'browser-service.log'), path.join(getBrowserLogsDir(), 'browser-service.legacy.log')],
  ];
}

export function getDevicesDir(): string {
  return process.env.AGENTS_DEVICES_DIR ?? path.join(getAgentsHome(), 'devices');
}

export function getDeviceMetaPath(id: string = machineId()): string {
  return path.join(getDevicesDir(), id, 'agents.yaml');
}

export function getCentralMetaPath(): string {
  return path.join(getUserAgentsDir(), 'agents.yaml');
}

function parseYamlFile(file: string): Record<string, unknown> {
  try {
    const parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* missing or malformed */ }
  return {};
}

function writeYamlFile(file: string, doc: Record<string, unknown>): void {
  const contents = yaml.stringify(doc);
  try { if (fs.readFileSync(file, 'utf8') === contents) return; } catch { /* first write */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(getBrowserLocalDir(), { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(getBrowserLocalDir(), 'yaml-'));
  try {
    const payload = path.join(temporary, 'document');
    fs.writeFileSync(payload, contents, { mode: 0o600 });
    fs.renameSync(payload, file);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function readProfileDeclarations(file: string, legacy = false): Record<string, BrowserProfileConfig> {
  if (!fs.existsSync(file)) return {};
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  try {
    const parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    if (parsed == null) return {};
    if (!isRecord(parsed)) throw new Error('document root must be a map');
    const profiles = legacy ? parsed.browser : parsed;
    if (profiles == null) return {};
    if (!isRecord(profiles)) throw new Error('browser must be a map');
    for (const [name, config] of Object.entries(profiles)) {
      if (!isRecord(config)) throw new Error(`profile "${name}" must be a map`);
    }
    return profiles as Record<string, BrowserProfileConfig>;
  } catch (error) {
    throw new Error(`Cannot read browser declarations from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOfferedProfiles(device: string): Record<string, BrowserProfileConfig> {
  const file = getBrowserProfilesPath(device);
  return readProfileDeclarations(fs.existsSync(file) ? file : getDeviceMetaPath(device), !fs.existsSync(file));
}

export function readBrowserSettings(): Record<string, unknown> {
  if (!fs.existsSync(getBrowserSettingsPath())) withMetaLock(() => migrateBrowserSettings());
  return parseYamlFile(getBrowserSettingsPath());
}

function migrateBrowserSettings(): void {
  if (fs.existsSync(getBrowserSettingsPath())) return;
  const file = getDeviceMetaPath();
  const device = parseYamlFile(file);
  const config = device.config as Record<string, unknown> | undefined;
  const values = [config?.browserRemoteControl, config?.['browser.remote-control']].filter(v => v !== undefined);
  writeYamlFile(getBrowserSettingsPath(), values.length ? { browserRemoteControl: values.every(v => v === true) } : {});
  if (config && values.length) {
    delete config.browserRemoteControl;
    delete config['browser.remote-control'];
    writeYamlFile(file, device);
  }
}

export function setBrowserConsent(value: unknown): void {
  withMetaLock(() => {
    migrateBrowserSettings();
    const settings = parseYamlFile(getBrowserSettingsPath());
    if (value === undefined) delete settings.browserRemoteControl;
    else settings.browserRemoteControl = value === true;
    writeYamlFile(getBrowserSettingsPath(), settings);
  });
}

export function readMeta(): Meta {
  const central = parseYamlFile(getCentralMetaPath());
  const device = parseYamlFile(getDeviceMetaPath());
  const offered = readOfferedProfiles(machineId());
  const privateBrowser = readProfileDeclarations(getBrowserLocalProfilesPath());
  const deviceBrowser = { ...offered, ...privateBrowser };
  const deviceConfig = (device.config && typeof device.config === 'object' && !Array.isArray(device.config))
    ? device.config as Record<string, unknown>
    : undefined;
  const browser = (central.browser && typeof central.browser === 'object' && !Array.isArray(central.browser))
    ? central.browser as Record<string, BrowserProfileConfig>
    : undefined;
  return {
    ...central,
    privateBrowser,
    ...(browser ? { browser } : {}),
    ...(deviceBrowser ? { deviceBrowser } : {}),
    ...(deviceConfig ? { deviceConfig } : {}),
  };
}

export function writeMetaUnlocked(meta: Meta): boolean {
  const centralPath = getCentralMetaPath();
  const central = parseYamlFile(centralPath);
  if (Object.prototype.hasOwnProperty.call(meta, 'browser')) {
    if (meta.browser && Object.keys(meta.browser).length > 0) central.browser = meta.browser;
    else delete central.browser;
    writeYamlFile(centralPath, central);
  }

  const devicePath = getDeviceMetaPath();
  const device = parseYamlFile(devicePath);
  if (Object.prototype.hasOwnProperty.call(meta, 'deviceBrowser')) {
    const privateNames = meta.privateBrowser ?? {};
    const offered: Record<string, BrowserProfileConfig> = {};
    const local: Record<string, BrowserProfileConfig> = {};
    for (const [name, config] of Object.entries(meta.deviceBrowser ?? {})) {
      (Object.hasOwn(privateNames, name) ? local : offered)[name] = config;
    }
    const offeredFile = getBrowserProfilesPath();
    if ((Object.keys(offered).length || fs.existsSync(offeredFile)) &&
      (!fs.existsSync(offeredFile) || !isDeepStrictEqual(readProfileDeclarations(offeredFile), offered))) {
      writeYamlFile(offeredFile, offered);
    }
    if (Object.keys(local).length || fs.existsSync(getBrowserLocalProfilesPath())) writeYamlFile(getBrowserLocalProfilesPath(), local);
    if (Object.keys(offered).length) device.browser = offered;
    else delete device.browser;
  }
  if (Object.prototype.hasOwnProperty.call(meta, 'deviceConfig')) {
    if (meta.deviceConfig && Object.keys(meta.deviceConfig).length > 0) device.config = meta.deviceConfig;
    else delete device.config;
  }
  if (fs.existsSync(getBrowserSettingsPath()) && device.config && typeof device.config === 'object') {
    delete (device.config as Record<string, unknown>).browserRemoteControl;
    delete (device.config as Record<string, unknown>)['browser.remote-control'];
  }
  if (Object.keys(device).length || fs.existsSync(devicePath)) writeYamlFile(devicePath, device);
  return true;
}

export function updateMeta(updates: Partial<Meta> | ((meta: Meta) => Meta)): Meta {
  return withMetaLock(() => {
    const current = readMeta();
    const next = typeof updates === 'function' ? updates(current) : { ...current, ...updates };
    writeMetaUnlocked(next);
    return next;
  });
}

const META_LOCK_STALE_MS = 5_000;
const META_LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Serialize `agents.yaml` writes with agents-cli, which locks it the same way
 * (`proper-lockfile`: an `agents.yaml.lock` directory, 5s stale, realpath).
 */
export function withMetaLock<T>(fn: () => T): T {
  const target = getCentralMetaPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // proper-lockfile needs the file to exist. A placeholder made only to lock is
  // removed again if the write left it empty: agents-cli treats a missing
  // agents.yaml as "run the first-run setup", and an empty one would skip it.
  let placeholder = false;
  try {
    fs.writeFileSync(target, '', { flag: 'wx' });
    placeholder = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  try {
    return withLockedTarget(target, fn);
  } finally {
    if (placeholder) {
      try {
        if (fs.statSync(target).size === 0) fs.unlinkSync(target);
      } catch { /* already gone */ }
    }
  }
}

function withLockedTarget<T>(target: string, fn: () => T): T {
  // Builds before 0.1.11 left a plain file here that was never a lock.
  // agents-cli only ever creates a directory at this path, so a file is that leftover.
  const legacy = `${fs.realpathSync(target)}.lock`;
  try {
    if (fs.lstatSync(legacy).isFile()) fs.unlinkSync(legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const deadline = Date.now() + META_LOCK_ACQUIRE_TIMEOUT_MS;
  let release: (() => void) | undefined;
  // proper-lockfile's default onCompromised throws from a timer, an uncaught
  // crash with no caller on the stack. Capture it and fail the write instead.
  let compromised: Error | undefined;
  for (let attempt = 0; !release; attempt++) {
    try {
      release = lockfile.lockSync(target, {
        stale: META_LOCK_STALE_MS,
        realpath: true,
        onCompromised: (error: Error) => { compromised = error; },
      });
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Could not lock ${target} after ${META_LOCK_ACQUIRE_TIMEOUT_MS}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      Atomics.wait(sleepCell, 0, 0, Math.min(50 * (attempt + 1), 250));
    }
  }
  try {
    const result = fn();
    if (compromised) throw new Error(`Lost the lock on ${target} during the write: ${compromised.message}`);
    return result;
  } finally {
    // A lock a peer already broke cannot be released; that must not mask fn's error.
    try { release(); } catch { /* already gone */ }
  }
}

export function commitCentralConfigAfterWrite(_centralChanged: boolean): void {
}

const migrationBlocks = new Map<string, string>();
export function setBrowserMigrationBlock(reason?: string): void {
  if (reason) migrationBlocks.set(getBrowserHome(), reason);
  else migrationBlocks.delete(getBrowserHome());
}
export function assertBrowserHomeReady(): void {
  const reason = migrationBlocks.get(getBrowserHome());
  if (reason) throw new Error(reason);
}

function assertLegacyStoreMoved(legacy: string): void {
  assertBrowserHomeReady();
  if (fs.existsSync(legacy) && fs.statSync(legacy).isDirectory()) {
    throw new Error(`Browser data remains at ${legacy}. Close the browser using it, resolve the migration warning, then restart the browser service.`);
  }
}
export function getBrowserProfileRuntimeDir(name: string): string {
  assertLegacyStoreMoved(path.join(getLegacyBrowserRuntimeDir(), name));
  return path.join(getBrowserRuntimeDir(), name);
}
export function getBrowserProfileDataDir(name: string): string {
  assertLegacyStoreMoved(path.join(getLegacyBrowserDurableDir(), name));
  return path.join(getBrowserDurableDir(), name, 'chrome-data');
}

export function getBrowserSshDir(base = getBrowserServiceDir()): string { return path.join(base, 'ssh'); }
export function getBrowserLoginScratchDir(): string { return path.join(getBrowserRuntimeDir(), 'login-inspection'); }
