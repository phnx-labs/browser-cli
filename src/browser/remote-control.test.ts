import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {
  FLEET_REMOTE_ENV,
  isFleetRemoteInvocation,
  assertRemoteControlAllowed,
  assertRemoteControlAllowedForRequest,
  remoteControlEnabled,
} from './remote-control.js';
import { setConfigValue } from '../runtime/device-config.js';
import { resolveBrowserTarget } from './resolve-target.js';

// A throwaway agents home: the registry, the consent switch and the daemon's
// runtime state all resolve AGENTS_HOME on every call (`runtime/state.ts`).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-remote-control-'));
const HERE = 'here-box';
const PEER = 'peer-box';
const saved = {
  home: process.env.AGENTS_HOME,
  history: process.env.AGENTS_HISTORY_DIR,
  machine: process.env.AGENTS_SYNC_MACHINE_ID,
};

function declare(device: string, browser: Record<string, unknown>): void {
  const file = path.join(HOME, 'devices', device, 'agents.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify({ browser }));
}

beforeAll(() => {
  process.env.AGENTS_HOME = HOME;
  process.env.AGENTS_HISTORY_DIR = path.join(HOME, '.history');
  process.env.AGENTS_SYNC_MACHINE_ID = HERE;
});

afterAll(() => {
  for (const [key, value] of [
    ['AGENTS_HOME', saved.home],
    ['AGENTS_HISTORY_DIR', saved.history],
    ['AGENTS_SYNC_MACHINE_ID', saved.machine],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(HOME, 'devices'), { recursive: true, force: true });
});

describe('isFleetRemoteInvocation', () => {
  it('is true only when the marker env is exactly "1"', () => {
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: '1' })).toBe(true);
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: '0' })).toBe(false);
    expect(isFleetRemoteInvocation({ [FLEET_REMOTE_ENV]: 'true' })).toBe(false);
    expect(isFleetRemoteInvocation({})).toBe(false);
  });
});

describe('remote control is off until the owner turns it on', () => {
  it('denies a fleet-remote drive on a machine that never set the switch', () => {
    declare(HERE, {});
    expect(remoteControlEnabled()).toBe(false);
    expect(() => assertRemoteControlAllowedForRequest(true, { actor: 'box-a' })).toThrow(
      /box-a tried to drive/,
    );
  });

  it('allows it once `browser remote-control on` wrote the switch', () => {
    declare(HERE, {});
    setConfigValue('browser.remote-control', true);
    expect(remoteControlEnabled()).toBe(true);
    expect(() => assertRemoteControlAllowedForRequest(true)).not.toThrow();
  });
});

describe('assertRemoteControlAllowed', () => {
  it('never gates a local (non-fleet) invocation, even with consent off', () => {
    expect(() => assertRemoteControlAllowed({ env: {}, enabled: false })).not.toThrow();
  });

  it('allows a fleet-remote drive when the owner opted in', () => {
    expect(() =>
      assertRemoteControlAllowed({ env: { [FLEET_REMOTE_ENV]: '1' }, enabled: true }),
    ).not.toThrow();
  });

  it('refuses a fleet-remote drive when consent is off, and names how to enable it', () => {
    expect(() =>
      assertRemoteControlAllowed({
        env: { [FLEET_REMOTE_ENV]: '1', AGENTS_ACTOR_HOST: 'box-a' },
        enabled: false,
      }),
    ).toThrow(/box-a tried to drive.*browser remote-control on/s);
  });

  it('falls back to a generic actor label when none is forwarded', () => {
    expect(() =>
      assertRemoteControlAllowed({ env: { [FLEET_REMOTE_ENV]: '1' }, enabled: false }),
    ).toThrow(/A fleet machine tried to drive/);
  });
});

describe('assertRemoteControlAllowedForRequest', () => {
  it('never gates a local request', () => {
    expect(() => assertRemoteControlAllowedForRequest(undefined, { enabled: false })).not.toThrow();
    expect(() => assertRemoteControlAllowedForRequest(false, { enabled: false })).not.toThrow();
  });

  it('refuses a fleet-remote request when consent is off, naming the actor and the fix', () => {
    expect(() =>
      assertRemoteControlAllowedForRequest(true, { enabled: false, actor: 'box-a' }),
    ).toThrow(/box-a tried to drive.*browser remote-control on/s);
  });

  it('allows a fleet-remote request once the owner opted in', () => {
    expect(() => assertRemoteControlAllowedForRequest(true, { enabled: true })).not.toThrow();
  });

  // The daemon is long-lived and may have been auto-started by a fleet-remote
  // CLI, so a marker in its own environment must not gate later local drives.
  it('ignores the daemon environment: a leaked marker does not gate local drives', () => {
    const before = process.env[FLEET_REMOTE_ENV];
    process.env[FLEET_REMOTE_ENV] = '1';
    try {
      expect(() => assertRemoteControlAllowedForRequest(undefined, { enabled: false })).not.toThrow();
    } finally {
      if (before === undefined) delete process.env[FLEET_REMOTE_ENV];
      else process.env[FLEET_REMOTE_ENV] = before;
    }
  });
});

describe("a peer's profile goes through the peer's consent check", () => {
  const reachable = () => ({ reachable: true as const });
  const comet = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
  const chrome = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };

  it('resolves a profile only the peer declares to that peer, with no tunnel endpoint', () => {
    declare(HERE, {});
    declare(PEER, { 'comet-local': comet });
    const routed = resolveBrowserTarget('comet-local', { probe: reachable });
    expect(routed).toEqual({
      name: 'comet-local',
      kind: 'identity',
      device: PEER,
      local: false,
      picked: `Using comet-local on ${PEER}`,
    });
  });

  it('the daemon refuses to start it here and names the --device command instead', async () => {
    declare(HERE, {});
    declare(PEER, { 'comet-local': comet });
    const { BrowserService } = await import('./service.js');
    const service = new BrowserService();
    await expect(service.start('comet-local', { probe: reachable })).rejects.toThrow(
      `browser start --profile comet-local --device ${PEER}`,
    );
    expect(await service.status()).toEqual([]);
  });

  it('an interchangeable profile this machine also declares stays here', () => {
    declare(HERE, { shared: chrome });
    declare(PEER, { shared: chrome });
    const routed = resolveBrowserTarget('shared', { probe: reachable });
    expect(routed.local).toBe(true);
    expect(routed.device).toBe(HERE);
  });
});
