import { afterEach, beforeEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

// Every run is the real CLI against an isolated AGENTS_HOME, so the service,
// profiles and config it touches are disposable fixtures, never this machine's.
let home: string;
const devicePath = () => path.join(home, 'devices', 'fixture-host', 'agents.yaml');
const writeYaml = (file: string, doc: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(doc));
};

async function cli(args: string[], extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTS_') && !key.startsWith('BROWSER_')));
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'index.ts'), ...args], {
    env: { ...env, HOME: home, AGENTS_HOME: home, AGENTS_SYNC_MACHINE_ID: 'fixture-host', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-remote-control-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

it('migrates consent once and writes only local settings', async () => {
  const read = async () => JSON.parse((await cli(['remote-control', '--json'])).stdout).remoteControl;
  writeYaml(devicePath(), { config: { browserRemoteControl: true, computerHost: 'ssh://me@box' } });
  expect(await read()).toBe(true);
  expect(yaml.parse(fs.readFileSync(devicePath(), 'utf8')).config).toEqual({ computerHost: 'ssh://me@box' });
  expect((await cli(['remote-control', 'off', '--json'])).code).toBe(0);
  writeYaml(devicePath(), { config: { browserRemoteControl: true } });
  expect(await read()).toBe(false);
  expect((await cli(['remote-control', 'on', '--json'])).code).toBe(0);
  expect(yaml.parse(fs.readFileSync(path.join(home, 'browser', 'local', 'settings.yaml'), 'utf8'))).toEqual({ browserRemoteControl: true });
  expect(await read()).toBe(true);
}, 30_000);

it('refuses a fleet-remote start before any service or profile state exists', async () => {
  writeYaml(devicePath(), { config: { browserRemoteControl: false, 'browser.remote-control': true, defaultBrowserProfile: 'fixture' } });
  const result = await cli(['start', '--url', 'about:blank', '--json'], { AGENTS_FLEET_REMOTE: '1', AGENTS_ACTOR_HOST: 'caller-host' });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('caller-host');
  expect(result.stderr).toContain('remote-control on');
  expect(fs.existsSync(path.join(home, 'browser', 'run'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'browser', 'cache'))).toBe(false);
}, 30_000);

const chrome = process.env.AGENTS_TEST_CHROME;

it.skipIf(!chrome)('an opted-in device serves a fleet-remote start on the profile it is given', async () => {
  const created = await cli(['profiles', 'create', 'fixture', '--browser', 'chromium', '--binary', chrome!, '--headless']);
  expect(created.code).toBe(0);
  const device = yaml.parse(fs.readFileSync(devicePath(), 'utf8'));
  writeYaml(devicePath(), { ...device, config: { browserRemoteControl: true, defaultBrowserProfile: 'not-declared' } });
  try {
    const started = await cli(
      ['start', '--profile', 'fixture', '--url', 'data:text/html,<title>fixture-ok</title>', '--no-skills', '--json'],
      { AGENTS_FLEET_REMOTE: '1', AGENTS_ACTOR_HOST: 'caller-host' },
    );
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    expect(JSON.parse(started.stdout).profile).toBe('fixture');
  } finally {
    await cli(['stop', '--service']);
  }
}, 60_000);
