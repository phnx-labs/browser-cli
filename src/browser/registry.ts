import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { commitCentralConfigAfterWrite, getDevicesDir, getDeviceMetaPath, getBrowserProfilesDir, getBrowserProfilesPath, getBrowserLocalProfilesPath, readProfileDeclarations, readMeta, updateMeta, withMetaLock, writeMetaUnlocked } from '../runtime/state.js';
import { machineId } from '../runtime/machine-id.js';
import type { BrowserProfileConfig, Meta } from '../runtime/types.js';

export interface ProfileDeclaration {
  device: string;
  config: BrowserProfileConfig;
}

type LegacyBrowserMeta = Meta & { browser?: Record<string, BrowserProfileConfig> };

/**
 * The leftover central `browser:` map from before per-device declarations, drained on sync. Read
 * only for migration and resolve errors, never for resolution: {@link profileRegistry} is the truth.
 */
export function centralBrowserProfiles(): Record<string, BrowserProfileConfig> {
  const central = (readMeta() as LegacyBrowserMeta).browser;
  if (!central || Object.keys(central).length === 0) return {};
  return { ...central };
}

export interface CentralClaimResult {
  claimed: string[];
  skipped: string[];
}

// Central entries this machine can host, so a peer's `cdp://localhost:*` profile is never claimed.
// An identical local declaration folds in; a different one throws for the explicit claim and is
// skipped on sync, so a stray duplicate never wedges it.
function selectClaimableCentral(
  central: Record<string, BrowserProfileConfig>,
  local: Record<string, BrowserProfileConfig>,
  canHostHere: (config: BrowserProfileConfig) => boolean,
  opts: { name?: string; onConflict: 'throw' | 'skip' },
): { toClaim: Record<string, BrowserProfileConfig>; skipped: string[] } {
  const toClaim: Record<string, BrowserProfileConfig> = {};
  const skipped: string[] = [];
  for (const [profileName, config] of Object.entries(central)) {
    if (opts.name && profileName !== opts.name) continue;
    if (!canHostHere(config)) {
      skipped.push(profileName);
      continue;
    }
    const existing = local[profileName];
    if (existing && !isDeepStrictEqual(existing, config)) {
      if (opts.onConflict === 'throw') {
        throw new Error(
          `Cannot migrate browser profile "${profileName}": central agents.yaml and this device's ` +
            `agents.yaml declare different configurations. Resolve the duplicate before retrying.`,
        );
      }
      skipped.push(profileName);
      continue;
    }
    toClaim[profileName] = config;
  }
  return { toClaim, skipped };
}

// `current` with `toClaim` moved from central `browser:` into `deviceBrowser`, dropping the central
// key once drained. Pure; the caller applies it under the meta lock.
function buildEvictedMeta(current: Meta, toClaim: Record<string, BrowserProfileConfig>): Meta {
  const legacy = current as LegacyBrowserMeta;
  const remaining: Record<string, BrowserProfileConfig> = {};
  for (const [profileName, config] of Object.entries(legacy.browser ?? {})) {
    if (!(profileName in toClaim)) remaining[profileName] = config;
  }
  const { browser: _removed, ...withoutCentralBrowser } = legacy;
  return {
    ...withoutCentralBrowser,
    browser: Object.keys(remaining).length > 0 ? remaining : undefined,
    deviceBrowser: { ...current.deviceBrowser, ...toClaim },
  } as Meta;
}

// The explicit claim selects from an unlocked snapshot, acceptable for a manual command; the
// automatic path selects inside the lock instead.
function commitCentralClaim(toClaim: Record<string, BrowserProfileConfig>): void {
  updateMeta((current) => buildEvictedMeta(current, toClaim));
}

/**
 * `browser profiles claim`: folds hostable central entries into this device's file, throwing on
 * conflict. Never implicit, since a read-time claim races; `canHostHere` is injected to avoid a cycle.
 */
export function migrateCentralBrowserProfiles(
  canHostHere: (config: BrowserProfileConfig) => boolean,
  name?: string,
): CentralClaimResult {
  const meta = readMeta() as LegacyBrowserMeta;
  const central = meta.browser;
  if (!central || Object.keys(central).length === 0) {
    if (name) {
      throw new Error(`No leftover central browser profile named "${name}".`);
    }
    return { claimed: [], skipped: [] };
  }

  const local = meta.deviceBrowser ?? {};
  if (name) {
    const config = central[name];
    if (!config) {
      throw new Error(
        local[name]
          ? `Browser profile "${name}" is already declared on this device.`
          : `No leftover central browser profile named "${name}".`,
      );
    }
    if (!canHostHere(config)) {
      throw new Error(
        `Cannot claim browser profile "${name}": this machine cannot host it ` +
          `(its browser/binary isn't installed here). Run this command on the machine that has that browser.`,
      );
    }
  }

  const { toClaim, skipped } = selectClaimableCentral(central, local, canHostHere, {
    name,
    onConflict: 'throw',
  });

  const claimed = Object.keys(toClaim).sort();
  skipped.sort();
  if (claimed.length === 0) return { claimed, skipped };

  commitCentralClaim(toClaim);
  return { claimed, skipped };
}

/**
 * The sync-time, never-throwing {@link migrateCentralBrowserProfiles}. Call it after the sync's pull:
 * on a pre-pull view a box can re-claim a profile a peer already drained, making it fungible.
 */
export function autoEvictCentralBrowserProfiles(
  canHostHere: (config: BrowserProfileConfig) => boolean,
): CentralClaimResult {
  // Read, select and commit in one lock so a concurrent local write is never overwritten by a stale
  // selection. Like updateMeta, but writes only when something is claimed, so a no-op sync touches nothing.
  let centralChanged = false;
  const result = withMetaLock(() => {
    const meta = readMeta() as LegacyBrowserMeta;
    const central = meta.browser;
    if (!central || Object.keys(central).length === 0) return { claimed: [], skipped: [] };
    const local = meta.deviceBrowser ?? {};
    const { toClaim, skipped } = selectClaimableCentral(central, local, canHostHere, {
      onConflict: 'skip',
    });
    const claimed = Object.keys(toClaim).sort();
    skipped.sort();
    if (claimed.length === 0) return { claimed, skipped };
    centralChanged = writeMetaUnlocked(buildEvictedMeta(meta, toClaim));
    return { claimed, skipped };
  });
  // Commit the central eviction AFTER the meta lock releases (the invariant:
  // every non-daemon central write commits after the lock, so agents.yaml is
  // never left dirty at rest to re-open the pull-trip window). Gated inside the
  // helper on centralChanged && !isDaemonProcess().
  commitCentralConfigAfterWrite(centralChanged);
  return result;
}

/**
 * Every profile any device declares, keyed by name to all declaring devices.
 * Reads offered YAMLs, legacy device declarations, and this machine's private profiles.
 */
export function profileRegistry(): Map<string, ProfileDeclaration[]> {
  const registry = new Map<string, ProfileDeclaration[]>();
  const devices = new Set<string>();
  if (fs.existsSync(getDevicesDir())) for (const entry of fs.readdirSync(getDevicesDir(), { withFileTypes: true })) {
    if (entry.isDirectory()) devices.add(entry.name);
  }
  if (fs.existsSync(getBrowserProfilesDir())) for (const entry of fs.readdirSync(getBrowserProfilesDir())) {
    if (entry.endsWith('.yaml')) devices.add(entry.slice(0, -5));
  }
  devices.add(machineId());
  const files: Array<{ device: string; file: string; legacy: boolean }> = [];
  for (const device of [...devices].sort()) {
    const offered = getBrowserProfilesPath(device);
    const file = fs.existsSync(offered) ? offered : getDeviceMetaPath(device);
    if (fs.existsSync(file)) files.push({ device, file, legacy: file !== offered });
  }
  if (fs.existsSync(getBrowserLocalProfilesPath())) files.push({ device: machineId(), file: getBrowserLocalProfilesPath(), legacy: false });
  for (const { device, file, legacy } of files) {
    for (const [name, config] of Object.entries(readProfileDeclarations(file, legacy))) {
      const declarations = (registry.get(name) ?? []).filter(entry => entry.device !== device);
      declarations.push({ device, config });
      registry.set(name, declarations);
    }
  }

  return registry;
}

/** Devices declaring `name`, empty when nobody does. */
export function declaringDevices(name: string): string[] {
  return (profileRegistry().get(name) ?? []).map((declaration) => declaration.device);
}

/** Exactly one declaring device is identity-bearing; several are fungible. */
export function profileKind(name: string): 'identity' | 'fungible' | null {
  const count = profileRegistry().get(name)?.length ?? 0;
  if (count === 0) return null;
  return count === 1 ? 'identity' : 'fungible';
}
