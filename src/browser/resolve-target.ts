/**
 * Where a profile name connects: locally if this device declares it, on a declaring peer (whose
 * daemon checks its own consent) if only peers do; if nobody does, fail rather than create one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { machineId } from '../runtime/machine-id.js';
import {
  centralBrowserProfiles,
  declaringDevices,
  profileKind,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';
import { resolveEndpoint } from './profiles.js';
import {
  connectionKey,
  parseConnectionKey,
  type BrowserProfile,
  type ConnectionKey,
} from './types.js';
import { probeHost } from '../runtime/hosts.js';

export type DeviceProbeResult =
  | { reachable: true }
  | { reachable: false; reason: string };

export type DeviceProbe = (device: string) => DeviceProbeResult;

interface LocalBrowserTarget {
  name: string;
  kind: 'identity' | 'fungible';
  device: string;
  local: true;
  key: ConnectionKey;
  target: string;
  profile: BrowserProfile;
}

/** The profile lives only on `device`: forward the whole command there. */
interface PeerBrowserTarget {
  name: string;
  kind: 'identity' | 'fungible';
  device: string;
  local: false;
  /** Human line naming where the command runs. */
  picked: string;
}

export type ResolvedBrowserTarget = LocalBrowserTarget | PeerBrowserTarget;

/** Fork only fungible Electron profiles; identity-bearing ones share one connection. */
export function shouldForkProfile(
  kind: 'identity' | 'fungible',
  conn: { electron?: boolean; tasks: { size: number } },
): boolean {
  if (kind === 'identity') return false;
  return Boolean(conn.electron && conn.tasks.size > 0);
}

export function profileFromDeclaration(
  name: string,
  declaration: ProfileDeclaration,
): BrowserProfile {
  const config = declaration.config;
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
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
    arc: config.arc,
    firefox: config.firefox,
  };
}

/** Runtime key: profile name plus the resolved device. Drops `@endpoint-N`. */
export function profileConnectionKey(profileName: string, device: string): ConnectionKey {
  return connectionKey(profileName, device);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = row[0]!;
    row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = row[j + 1]!;
      const cost = a[i] === b[j] ? 0 : 1;
      row[j + 1] = Math.min(row[j]! + 1, row[j + 1]! + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Declared names that look like `query` — used in the undeclared error. */
export function similarProfileNames(query: string, names: string[]): string[] {
  const q = query.toLowerCase();
  const maxDist = Math.max(2, Math.floor(q.length / 4));
  return names
    .filter((name) => {
      const x = name.toLowerCase();
      if (x === q) return false;
      if (x.includes(q) || q.includes(x)) return Math.min(x.length, q.length) >= 3;
      return levenshtein(x, q) <= maxDist;
    })
    .sort();
}

function lines(...parts: string[]): string {
  return parts.filter((part) => part != null && part !== '').join('\n');
}

export function undeclaredProfileError(name: string): Error {
  const central = centralBrowserProfiles();
  if (central[name]) {
    return new Error(
      lines(
        `Browser profile "${name}" is not declared by any device.`,
        `It still lives in the central agents.yaml browser: map.`,
        `Claim it on the machine that hosts that browser with: browser profiles claim ${name}`,
      ),
    );
  }

  const registry = profileRegistry();
  const similar = similarProfileNames(name, [...registry.keys()]);
  const similarLines = similar.map((candidate) => {
    const devices = (registry.get(candidate) ?? []).map((entry) => entry.device);
    return devices.length > 0
      ? `  ${candidate} (declared on ${devices.join(', ')})`
      : `  ${candidate}`;
  });

  return new Error(
    lines(
      `Browser profile "${name}" is not declared by any device.`,
      ...(similarLines.length > 0
        ? ['Similar names:', ...similarLines]
        : ['No device declares a similar name.']),
      `Create it on the machine that hosts the browser: browser profiles create ${name} --browser <chrome|comet|chromium|brave|edge|arc|custom>`,
      `Or, if it is a leftover central profile, claim it: browser profiles claim ${name}`,
    ),
  );
}

export function unreachableDeclaringDevicesError(
  name: string,
  devices: string[],
  failures: string[],
): Error {
  return new Error(
    lines(
      `Browser profile "${name}" is declared on ${devices.join(', ')}, but none of those devices are reachable.`,
      ...failures.map((line) => `  ${line}`),
      `A local browser will not be launched — that would be a logged-out copy of an identity-bearing profile.`,
    ),
  );
}

/** The daemon's refusal for a peer's profile: it never tunnels past the peer's consent. */
export function peerProfileError(name: string, device: string): Error {
  return new Error(
    lines(
      `Browser profile "${name}" lives on ${device}; this machine will not drive it directly.`,
      `Run the command on ${device}, which checks its own remote-control consent:`,
      `  browser start --profile ${name} --device ${device}`,
    ),
  );
}

function defaultProbe(device: string): DeviceProbeResult {
  try {
    const result = probeHost(device);
    if (result.reachable) return { reachable: true };
    return { reachable: false, reason: `ssh to ${device} failed` };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Decide where `name` connects. Never claims a central leftover. Never
 * falls back to a local browser when the name is declared elsewhere.
 */
export function resolveBrowserTarget(
  name: string,
  opts: {
    endpointName?: string;
    here?: string;
    probe?: DeviceProbe;
  } = {},
): ResolvedBrowserTarget {
  const here = opts.here ?? machineId();
  const kind = profileKind(name);
  const declarations = profileRegistry().get(name) ?? [];
  if (kind === null || declarations.length === 0) {
    throw undeclaredProfileError(name);
  }

  const devices = declaringDevices(name);
  const local = declarations.find((entry) => entry.device === here);

  if (local) {
    const profile = profileFromDeclaration(name, local);
    const resolved = resolveEndpoint(profile, opts.endpointName);
    return {
      name,
      kind,
      device: here,
      local: true,
      key: profileConnectionKey(name, here),
      target: resolved.target,
      profile: {
        ...profile,
        binary: resolved.binary,
        targetFilter: resolved.targetFilter,
      },
    };
  }

  const probe = opts.probe ?? defaultProbe;
  const candidates = [...declarations].sort((a, b) => a.device.localeCompare(b.device));
  const failures: string[] = [];

  for (const declaration of candidates) {
    const result = probe(declaration.device);
    if (!result.reachable) {
      failures.push(`${declaration.device}: ${result.reason}`);
      continue;
    }
    const picked =
      candidates.length > 1
        ? `Using ${name} on ${declaration.device} (declared on ${devices.join(', ')})`
        : `Using ${name} on ${declaration.device}`;
    return { name, kind, device: declaration.device, local: false, picked };
  }

  throw unreachableDeclaringDevicesError(name, devices, failures);
}

/**
 * Adopt a leftover `@endpoint-N` runtime dir only for a local connect: for a peer's key it would
 * rename this machine's logged-out chrome-data onto the peer's name and attach localhost CDP.
 */
export function adoptLegacyRuntimeIfLocal(
  local: boolean,
  profileName: string,
  newKey: ConnectionKey,
  runtimeRoot: string,
): void {
  if (!local) return;
  migrateLegacyRuntimeDir(profileName, newKey, runtimeRoot);
}

/**
 * Rename the one leftover `<name>@endpoint-N` runtime dir to `<name>@<device>` so its logins are
 * kept; several legacy dirs, or an existing destination, stay put.
 */
export function migrateLegacyRuntimeDir(
  profileName: string,
  newKey: ConnectionKey,
  runtimeRoot: string,
): void {
  const dest = path.join(runtimeRoot, newKey);
  if (fs.existsSync(dest)) return;
  if (!fs.existsSync(runtimeRoot)) return;

  const legacy = fs.readdirSync(runtimeRoot).filter((entry) => {
    const parsed = parseConnectionKey(entry);
    return (
      parsed.profile === profileName &&
      parsed.endpoint !== undefined &&
      /^endpoint-\d+$/.test(parsed.endpoint) &&
      parsed.fork === undefined
    );
  });
  if (legacy.length !== 1) return;
  fs.renameSync(path.join(runtimeRoot, legacy[0]!), dest);
}

/** True when a live key is a leftover `@endpoint-N` key of `profileName`. */
export function isLegacyEndpointKey(key: string, profileName: string): boolean {
  const parsed = parseConnectionKey(key);
  return (
    parsed.profile === profileName &&
    parsed.endpoint !== undefined &&
    /^endpoint-\d+$/.test(parsed.endpoint)
  );
}
