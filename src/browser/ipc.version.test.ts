import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shouldRecommendDaemonRefresh } from './ipc.js';
import { getCliVersion } from '../version.js';

test('only stale or unordered daemon versions need a refresh', () => {
  expect(shouldRecommendDaemonRefresh('0.1.33', '0.1.34')).toBe(true);
  expect(shouldRecommendDaemonRefresh('0.0.0-dev.a', '0.0.0-dev.b')).toBe(true);
  for (const daemon of [undefined, 'unknown', '0.1.34', '0.1.35']) {
    expect(shouldRecommendDaemonRefresh(daemon, '0.1.34')).toBe(false);
  }
});

test('a stale daemon prints and logs one restart hint per process without requesting an update', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-version-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { reconcileDaemonVersion } from ${JSON.stringify(import.meta.dir + '/ipc.ts')};
      reconcileDaemonVersion('0.0.1');
      reconcileDaemonVersion('0.0.2');
      console.log('continued');
    `], { timeout: 5_000, env: { ...process.env, AGENTS_HOME: home } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('continued\n');
    const warning = result.stderr.toString();
    expect(warning.split('\n')).toHaveLength(2);
    expect(warning).toStartWith(`daemon is 0.0.1, CLI is ${getCliVersion()}: `);
    expect(warning).toContain('browser stop --service once no other agent is using the browser');
    const log = fs.readFileSync(path.join(home, 'browser', 'logs', 'daemon.jsonl'), 'utf8').trim().split('\n');
    expect(log.map((line) => JSON.parse(line))).toMatchObject([
      { event: 'daemon.version_mismatch', daemon: '0.0.1', cli: getCliVersion() },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
