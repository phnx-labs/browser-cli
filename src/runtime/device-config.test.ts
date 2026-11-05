import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { getConfigValue, resolveBrowserTaskIdleMs, setConfigValue, unsetConfigValue } from './device-config.js';
import { getCentralMetaPath, getDeviceMetaPath, getBrowserSettingsPath } from './state.js';

let home: string;
const previous = { home: process.env.AGENTS_HOME, machine: process.env.AGENTS_SYNC_MACHINE_ID };

const writeYaml = (file: string, doc: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(doc));
};
const deviceConfig = () => yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).config;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'device-config-'));
  process.env.AGENTS_HOME = home;
  process.env.AGENTS_SYNC_MACHINE_ID = 'fixture-host';
});

afterEach(() => {
  for (const [key, value] of [['AGENTS_HOME', previous.home], ['AGENTS_SYNC_MACHINE_ID', previous.machine]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe('device config keys', () => {
  it('reads the keys agents-cli stores, then the dotted spelling older builds wrote', () => {
    writeYaml(getDeviceMetaPath(), {
      config: { defaultBrowserProfile: 'work', 'browser.profile': 'stale', 'browser.viewer': 'os', browserTaskIdleMinutes: 0 },
    });
    expect(getConfigValue('browser.profile').value).toBe('work');
    expect(getConfigValue('browser.viewer').value).toBe('os');
    expect(getConfigValue('browser.task-idle-minutes').value).toBe(0);
    expect(getConfigValue('browser.remote-control').value).toBeUndefined();
  });

  it('idle 0 disables reaping; unset is 30 minutes', async () => {
    expect(await resolveBrowserTaskIdleMs()).toBe(30 * 60_000);
    writeYaml(getDeviceMetaPath(), { config: { browserTaskIdleMinutes: 0 } });
    expect(await resolveBrowserTaskIdleMs()).toBeNull();
    writeYaml(getDeviceMetaPath(), { config: { 'browser.task-idle-minutes': 5 } });
    expect(await resolveBrowserTaskIdleMs()).toBe(5 * 60_000);
  });

  it('remote control is on only when every stored spelling says true', () => {
    const consent = (config: Record<string, unknown>) => {
      fs.rmSync(getBrowserSettingsPath(), { force: true });
      writeYaml(getDeviceMetaPath(), { config });
      return getConfigValue('browser.remote-control').value;
    };
    expect(consent({ browserRemoteControl: true })).toBe(true);
    expect(consent({ 'browser.remote-control': true })).toBe(true);
    expect(consent({ browserRemoteControl: true, 'browser.remote-control': true })).toBe(true);
    expect(consent({ browserRemoteControl: false, 'browser.remote-control': true })).toBe(false);
    expect(consent({ browserRemoteControl: true, 'browser.remote-control': false })).toBe(false);
    expect(consent({ browserRemoteControl: 'yes' })).toBe(false);
  });

  it('setting writes the stored key, drops only its dotted twin and keeps everything else', () => {
    writeYaml(getDeviceMetaPath(), {
      name: 'fixture-host',
      config: { 'browser.remote-control': false, 'browser.viewer': 'arc', computerHost: 'ssh://me@box' },
    });
    setConfigValue('browser.remote-control', true);
    expect(deviceConfig()).toEqual({ 'browser.viewer': 'arc', computerHost: 'ssh://me@box' });
    expect(yaml.parse(fs.readFileSync(getBrowserSettingsPath(), 'utf8'))).toEqual({ browserRemoteControl: true });
    expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).name).toBe('fixture-host');
    unsetConfigValue('browser.viewer');
    expect(deviceConfig()).toEqual({ computerHost: 'ssh://me@box' });
  });

  it('remote control stays local to this device', () => {
    writeYaml(path.join(home, 'devices', 'other-host', 'agents.yaml'), { config: { browserRemoteControl: true } });
    writeYaml(getCentralMetaPath(), { config: { browserRemoteControl: true } });
    expect(getConfigValue('browser.remote-control').value).toBeUndefined();
  });

  it('reads the fleet hub from the central config, then a dotted device value', () => {
    writeYaml(getDeviceMetaPath(), { config: { 'browser.device': 'old-hub' } });
    expect(getConfigValue('browser.device').value).toBe('old-hub');
    writeYaml(getCentralMetaPath(), { config: { defaultBrowserDevice: 'hub' } });
    expect(getConfigValue('browser.device')).toEqual({ value: 'hub', source: 'user' });
  });
});
