import { readMeta, updateMeta, readBrowserSettings, setBrowserConsent } from './state.js';

export interface ConfigEntry {
  value: unknown;
  source?: string;
}

export interface ConfigTarget {
  device?: string;
}

/**
 * Where agents-cli stores each setting, so both tools share one value. The dotted
 * name older builds wrote is still read when the stored key is absent.
 */
const KEYS = {
  'browser.remote-control': { yamlKey: 'browserRemoteControl', scope: 'device' },
  'browser.profile': { yamlKey: 'defaultBrowserProfile', scope: 'device' },
  'browser.viewer': { yamlKey: 'browserViewer', scope: 'device' },
  'browser.task-idle-minutes': { yamlKey: 'browserTaskIdleMinutes', scope: 'device' },
  'browser.device': { yamlKey: 'defaultBrowserDevice', scope: 'user' },
} as const;

export type ConfigKey = keyof typeof KEYS;
export type DeviceConfigKey = { [K in ConfigKey]: (typeof KEYS)[K]['scope'] extends 'device' ? K : never }[ConfigKey];

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getConfigValue(name: ConfigKey, _opts?: ConfigTarget): ConfigEntry {
  if (name === 'browser.remote-control') {
    const value = readBrowserSettings().browserRemoteControl;
    return value === undefined ? { value } : { value: value === true, source: 'local' };
  }
  const meta = readMeta();
  const device = meta.deviceConfig ?? {};
  const spec = KEYS[name];
  if (spec.scope === 'user') {
    const central = objectOrEmpty(meta.config)[spec.yamlKey];
    if (central !== undefined) return { value: central, source: 'user' };
  }
  const stored = (spec.scope === 'device' ? [device[spec.yamlKey], device[name]] : [device[name]]).filter((v) => v !== undefined);
  if (stored.length === 0) return { value: undefined };
  return { value: stored[0], source: 'device' };
}

export async function getConfigValueAsync(name: ConfigKey, opts?: ConfigTarget): Promise<ConfigEntry> {
  return getConfigValue(name, opts);
}

export function setConfigValue(name: DeviceConfigKey, value: unknown, _opts?: ConfigTarget): void {
  if (name === 'browser.remote-control') { setBrowserConsent(value); return; }
  updateMeta((meta) => {
    const next = { ...meta.deviceConfig, [KEYS[name].yamlKey]: value };
    delete next[name];
    return { ...meta, deviceConfig: next };
  });
}

export function unsetConfigValue(name: DeviceConfigKey, _opts?: ConfigTarget): void {
  if (name === 'browser.remote-control') { setBrowserConsent(undefined); return; }
  updateMeta((meta) => {
    const next = { ...meta.deviceConfig };
    delete next[KEYS[name].yamlKey];
    delete next[name];
    return { ...meta, deviceConfig: next };
  });
}

export function devicesPinningBrowserProfile(_name: string): { device: string; key: 'browser.profile' | 'browser.viewer' }[] {
  return [];
}

export async function resolveBrowserTaskIdleMs(): Promise<number | null> {
  const minutes = ((await getConfigValueAsync('browser.task-idle-minutes')).value as number | undefined) ?? 30;
  return minutes === 0 ? null : minutes * 60_000;
}
