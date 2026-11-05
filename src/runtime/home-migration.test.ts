import { afterEach, beforeEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import * as yaml from 'yaml';
import lockfile from 'proper-lockfile';
import { migrateBrowserHome } from './home-migration.js';
import { browserStateMoves, getBrowserHome, getBrowserHistoryPath, getBrowserProfilesPath, getBrowserLocalProfilesPath,
  getBrowserMigrationMarkerPath, getBrowserMigrationLockPath, getBrowserLocalDir, getCentralMetaPath,
  getBrowserSettingsPath, getDeviceMetaPath, getBrowserServiceLockPath, getBrowserSocketPath,
  getBrowserConflictDir, getBrowserProfileDataDir, getLegacyBrowserDurableDir, getLegacyBrowserRuntimeDir, getLegacyBrowserServiceDir, readMeta, updateMeta } from './state.js';
import { bindTask } from '../browser/task-index.js';
import { profileRegistry } from '../browser/registry.js';
import { readTaskSummaries, writeTaskSummary } from './task-history.js';
import { getConfigValue, setConfigValue, unsetConfigValue } from './device-config.js';

let home: string;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTS_')) delete process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-home-'));
  process.env.AGENTS_HOME = home;
  process.env.AGENTS_SYNC_MACHINE_ID = 'fixture';
});
afterEach(() => { process.env = previous; fs.rmSync(home, { recursive: true, force: true }); });

function write(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
const profile = { browser: 'chromium' as const, endpoints: ['cdp://localhost:9222'] };

function seed(): Map<string, number> {
  const inodes = new Map<string, number>();
  for (const [source, destination] of browserStateMoves()) {
    if (source.endsWith('.log')) write(source, 'old service output\n');
    else write(path.join(source, 'fixture'), 'preserved');
    inodes.set(destination, fs.statSync(source).ino);
  }
  write(path.join(getLegacyBrowserServiceDir(), 'fixture'), 'runtime');
  const oldDb = path.join(home, '.history', 'browser', 'history.db');
  const db = new Database(oldDb);
  db.exec(fs.readFileSync(path.join(import.meta.dir, 'testdata', 'history-before-native.sql'), 'utf8'));
  const now = Date.now();
  db.query('INSERT INTO tasks VALUES(?,?,?,?)').run('work', 'old', now, JSON.stringify({ profile: 'work', task: 'old', startedAt: now, lastActivity: now, captureDir: path.join(getLegacyBrowserRuntimeDir(), 'work', 'sessions', 'old') }));
  db.close();
  write(getDeviceMetaPath(), yaml.stringify({ browser: { work: profile }, config: { browserRemoteControl: true } }));
  return inodes;
}

it('renames every legacy store without copying, preserves history and is idempotent', async () => {
  const inodes = seed();
  const messages: string[] = [];
  await migrateBrowserHome(message => messages.push(message));
  for (const [destination, inode] of inodes) expect(fs.statSync(destination).ino).toBe(inode);
  for (const [source] of browserStateMoves()) {
    if (!source.endsWith('.log')) expect(fs.statSync(source).isFile()).toBe(true);
    else expect(fs.existsSync(source)).toBe(false);
  }
  expect(fs.readFileSync(path.join(getBrowserHome(), 'run', 'fixture'), 'utf8')).toBe('runtime');
  const db = new Database(getBrowserHistoryPath());
  expect(JSON.parse((db.query('SELECT record FROM tasks').get() as { record: string }).record).captureDir).toBe(path.join(getBrowserHome(), 'cache', 'work', 'sessions', 'old'));
  db.close();
  expect(messages).toEqual([]);
  await migrateBrowserHome(message => messages.push(message));
  expect(messages).toEqual([]);
  expect(getConfigValue('browser.remote-control').value).toBe(true);
});

it('a genuine destination conflict preserves both copies and does not stop startup', async () => {
  const source = getLegacyBrowserRuntimeDir();
  const destination = path.join(getBrowserHome(), 'cache');
  write(path.join(source, 'Cookies'), 'original');
  write(path.join(destination, 'Cookies'), 'new copy');
  const messages: string[] = [];
  await migrateBrowserHome(message => messages.push(message));
  expect(fs.statSync(source).isFile()).toBe(true);
  expect(fs.readFileSync(path.join(destination, 'Cookies'), 'utf8')).toBe('new copy');
  const backup = fs.readdirSync(getBrowserConflictDir())[0];
  expect(fs.readFileSync(path.join(getBrowserConflictDir(), backup, 'Cookies'), 'utf8')).toBe('original');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('reconcile it');
  await daemon();
});

it('dual writes offered profiles, reads old and new peers, and keeps private profiles local', () => {
  write(getDeviceMetaPath('old-peer'), yaml.stringify({ browser: { old: profile } }));
  write(getBrowserProfilesPath('new-peer'), yaml.stringify({ modern: profile }));
  write(getBrowserLocalProfilesPath(), yaml.stringify({ scratch: profile }));
  updateMeta(meta => ({ ...meta, deviceBrowser: { ...meta.deviceBrowser, offered: profile } }));
  expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).browser).toEqual({ offered: profile });
  expect(yaml.parse(fs.readFileSync(getBrowserProfilesPath(), 'utf8'))).toEqual({ offered: profile });
  expect([...profileRegistry().keys()].sort()).toEqual(['modern', 'offered', 'old', 'scratch']);
  expect(readMeta().deviceBrowser?.scratch).toEqual(profile);
  updateMeta(meta => ({ ...meta, deviceBrowser: { scratch: { ...profile, description: 'private edit' } } }));
  expect(yaml.parse(fs.readFileSync(getBrowserProfilesPath(), 'utf8'))).toEqual({});
  expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).browser).toBeUndefined();
  expect(profileRegistry().get('scratch')?.[0].config.description).toBe('private edit');
  expect(fs.existsSync(getBrowserProfilesPath('old-peer'))).toBe(false);
});

it('new declarations win over stale legacy copies, including deletion', () => {
  write(getDeviceMetaPath('peer'), yaml.stringify({ browser: { stale: profile } }));
  write(getBrowserProfilesPath('peer'), '{}\n');
  expect(profileRegistry().has('stale')).toBe(false);
});

it('consent migrates once, never revives from synced configuration, and remains private', () => {
  write(getDeviceMetaPath(), yaml.stringify({ config: { browserRemoteControl: false, 'browser.remote-control': true, other: 7 } }));
  expect(getConfigValue('browser.remote-control').value).toBe(false);
  expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).config).toEqual({ other: 7 });
  setConfigValue('browser.remote-control', true);
  unsetConfigValue('browser.remote-control');
  write(getDeviceMetaPath(), yaml.stringify({ config: { browserRemoteControl: true } }));
  expect(getConfigValue('browser.remote-control').value).toBeUndefined();
  expect(yaml.parse(fs.readFileSync(getBrowserSettingsPath(), 'utf8'))).toEqual({});
  updateMeta(meta => meta);
  expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).config).toEqual({});
});

it('git tracks only profile declarations, never cookies or consent, using the real home ignore rules', () => {
  const git = (...args: string[]) => spawnSync('git', ['-C', home, ...args], { encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  fs.copyFileSync(path.join(import.meta.dir, 'testdata', 'browser-home-ignore.txt'), path.join(home, '.gitignore'));
  const cookies = path.join(getBrowserProfileDataDir('work'), 'Default', 'Cookies');
  write(cookies, 'private');
  write(getBrowserSettingsPath(), '{}');
  write(getBrowserLocalProfilesPath(), '{}');
  write(getBrowserProfilesPath(), '{}');
  for (const file of [cookies, getBrowserSettingsPath(), getBrowserLocalProfilesPath()]) expect(git('check-ignore', file).status).toBe(0);
  expect(git('check-ignore', getBrowserProfilesPath()).status).toBe(1);
});

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'index.ts'), ...args], {
    env: { ...process.env, BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

async function daemon(): Promise<void> {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'index.ts'), '__serve'], {
    env: { ...process.env, BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined }, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(getBrowserSocketPath()) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(child.exitCode).toBeNull();
    expect(fs.existsSync(getBrowserServiceLockPath())).toBe(true);
    expect(fs.existsSync(getBrowserSocketPath())).toBe(true);
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }
}

it('sessions before the daemon migrates and retains old history, including an already-created fresh database', async () => {
  seed();
  fs.mkdirSync(path.dirname(getBrowserHistoryPath()), { recursive: true });
  const fresh = new Database(getBrowserHistoryPath(), { create: true });
  fresh.exec('CREATE TABLE placeholder (x INTEGER)');
  fresh.close();
  const result = await cli('sessions', '--tasks', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).some((row: { task: string }) => row.task === 'old')).toBe(true);
  expect(fs.statSync(getLegacyBrowserRuntimeDir()).isFile()).toBe(true);
  await daemon();
  expect(readTaskSummaries().map(row => row.task)).toContain('old');
}, 15_000);

it('pre-created empty destination directories merge, and tombstones stop old-layout recreation', async () => {
  seed();
  for (const [, destination] of browserStateMoves()) {
    fs.mkdirSync(destination.endsWith('.log') ? path.dirname(destination) : destination, { recursive: true });
  }
  await migrateBrowserHome();
  for (const [source] of browserStateMoves()) {
    if (source.endsWith('.log')) continue;
    expect(() => fs.mkdirSync(path.join(source, 'recreated'), { recursive: true })).toThrow();
  }
  await daemon();
});

it('resurrected legacy directories merge again without overwriting canonical files', async () => {
  seed();
  await migrateBrowserHome();
  const source = getLegacyBrowserRuntimeDir();
  fs.unlinkSync(source);
  write(path.join(source, 'late-capture'), 'from an old CLI');
  const result = await cli('sessions', '--tasks', '--json');
  expect(result.code).toBe(0);
  expect(fs.readFileSync(path.join(getBrowserHome(), 'cache', 'late-capture'), 'utf8')).toBe('from an old CLI');
  expect(fs.statSync(source).isFile()).toBe(true);
  await daemon();
});

it('merges populated histories and preserves the old database with its records', async () => {
  seed();
  writeTaskSummary({ profile: 'work', task: 'new', startedAt: Date.now(), lastActivity: Date.now() });
  await migrateBrowserHome(() => {});
  expect(readTaskSummaries().map(row => row.task).sort()).toEqual(['new', 'old']);
  const backup = fs.readdirSync(getBrowserConflictDir()).find(name => name.startsWith('browser-'))!;
  const db = new Database(path.join(getBrowserConflictDir(), backup, 'browser', 'history.db'), { readonly: true });
  expect(db.query('SELECT task FROM tasks').get()).toEqual({ task: 'old' });
  db.close();
});

it('serializes simultaneous first commands with an exclusive migration lock', async () => {
  seed();
  const results = await Promise.all([cli('sessions', '--tasks', '--json'), cli('sessions', '--tasks', '--json')]);
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).some((row: { task: string }) => row.task === 'old')).toBe(true);
  }
});

it.each(['SingletonLock', 'tasks.json'])('leaves a live sign-in store in place when %s names its process', async marker => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'pipe' });
  const store = path.join(getLegacyBrowserDurableDir(), 'work', 'chrome-data');
  const runtime = path.join(getLegacyBrowserRuntimeDir(), 'work');
  write(path.join(store, 'Default', 'Cookies'), 'signed in');
  if (marker === 'SingletonLock') fs.symlinkSync(`fixture-${child.pid}`, path.join(store, marker));
  else write(path.join(runtime, marker), JSON.stringify({ old: { pid: child.pid } }));
  try {
    const messages: string[] = [];
    await migrateBrowserHome(message => messages.push(message));
    expect(fs.readFileSync(path.join(store, 'Default', 'Cookies'), 'utf8')).toBe('signed in');
    expect(messages.join(' ')).toContain(`PID ${child.pid}`);
    expect(messages.join(' ')).toContain('Close that browser');
    expect(() => getBrowserProfileDataDir('work')).toThrow('Browser data remains');
    await daemon();
  } finally { child.kill(); await child.exited; }
  await migrateBrowserHome();
  expect(fs.readFileSync(path.join(getBrowserProfileDataDir('work'), 'Default', 'Cookies'), 'utf8')).toBe('signed in');
});

it('never migrates another home through inherited Agents directory overrides', async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-agents-'));
  try {
    for (const [key, relative] of Object.entries({ AGENTS_HISTORY_DIR: '.history', AGENTS_CACHE_DIR: '.cache', AGENTS_HELPERS_DIR: '.cache/helpers', AGENTS_LOGS_DIR: '.cache/logs' })) {
      process.env[key] = path.join(other, relative);
    }
    const oldHistory = path.join(other, '.history', 'browser', 'history.db');
    fs.mkdirSync(path.dirname(oldHistory), { recursive: true });
    fs.writeFileSync(oldHistory, 'must not touch');
    seed();
    await migrateBrowserHome();
    expect(fs.readFileSync(oldHistory, 'utf8')).toBe('must not touch');
    expect(fs.statSync(getLegacyBrowserRuntimeDir()).isFile()).toBe(true);
    expect(readTaskSummaries().map(row => row.task)).toContain('old');
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

it('does not move a store with a live DevToolsActivePort endpoint', async () => {
  const net = await import('node:net');
  const server = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const store = path.join(getLegacyBrowserDurableDir(), 'work', 'chrome-data');
  write(path.join(store, 'DevToolsActivePort'), `${port}\n/devtools/browser/fixture\n`);
  write(path.join(store, 'Default', 'Cookies'), 'preserved');
  try {
    const warnings: string[] = [];
    await migrateBrowserHome(message => warnings.push(message));
    expect(fs.readFileSync(path.join(store, 'Default', 'Cookies'), 'utf8')).toBe('preserved');
    expect(warnings.join(' ')).toContain(`DevTools port ${port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await migrateBrowserHome();
  expect(fs.readFileSync(path.join(getBrowserProfileDataDir('work'), 'Default', 'Cookies'), 'utf8')).toBe('preserved');
});

it.skipIf(process.platform === 'win32')('a real permission failure preserves the source and gives a repair path without throwing', async () => {
  seed();
  const destination = path.join(getBrowserHome(), 'cache');
  fs.mkdirSync(destination, { recursive: true });
  fs.chmodSync(destination, 0o500);
  try {
    const warnings: string[] = [];
    await migrateBrowserHome(message => warnings.push(message));
    expect(fs.readFileSync(path.join(getLegacyBrowserRuntimeDir(), 'fixture'), 'utf8')).toBe('preserved');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('move it by hand');
    expect(warnings[0]).toContain(path.join(getBrowserHome(), 'cache'));
  } finally { fs.chmodSync(destination, 0o700); }
  await migrateBrowserHome();
  expect(fs.statSync(getLegacyBrowserRuntimeDir()).isFile()).toBe(true);
});

it('preserves a file occupying a destination directory and makes the directory usable', async () => {
  const destination = path.join(getBrowserHome(), 'cache');
  write(destination, 'unrelated file');
  write(path.join(getLegacyBrowserRuntimeDir(), 'fixture'), 'old cache');
  await migrateBrowserHome(() => {});
  expect(fs.readFileSync(path.join(destination, 'fixture'), 'utf8')).toBe('old cache');
  const backup = fs.readdirSync(getBrowserConflictDir())[0];
  expect(fs.readFileSync(path.join(getBrowserConflictDir(), backup, 'cache'), 'utf8')).toBe('unrelated file');
  await daemon();
});

it('treats unrelated files named history.db as file conflicts, not browser history', async () => {
  write(path.join(getLegacyBrowserRuntimeDir(), 'work', 'history.db'), 'old download');
  write(path.join(getBrowserHome(), 'cache', 'work', 'history.db'), 'new download');
  await migrateBrowserHome(() => {});
  expect(fs.existsSync(getBrowserHistoryPath())).toBe(false);
  expect(fs.readFileSync(path.join(getBrowserHome(), 'cache', 'work', 'history.db'), 'utf8')).toBe('new download');
  const backup = fs.readdirSync(getBrowserConflictDir())[0];
  expect(fs.readFileSync(path.join(getBrowserConflictDir(), backup, 'history.db'), 'utf8')).toBe('old download');
});

it('completed migration skips held migration and Agents locks for subsequent CLI reads', async () => {
  seed();
  await migrateBrowserHome();
  write(getCentralMetaPath(), '{}\n');
  const releaseMeta = await lockfile.lock(getCentralMetaPath());
  const releaseMigration = await lockfile.lock(getBrowserLocalDir(), { lockfilePath: getBrowserMigrationLockPath(), realpath: false });
  const files = [getBrowserMigrationMarkerPath(), getBrowserSettingsPath(), getDeviceMetaPath(), getBrowserProfilesPath()];
  const before = files.map(file => fs.statSync(file).mtimeMs);
  try {
    const started = Date.now();
    const result = await cli('sessions', '--tasks', '--json');
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('browser migration:');
    expect(JSON.parse(result.stdout).some((row: { task: string }) => row.task === 'old')).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(files.map(file => fs.statSync(file).mtimeMs)).toEqual(before);
  } finally { await releaseMigration(); await releaseMeta(); }
});

it('a completion marker cannot skip missing consent migration', async () => {
  await migrateBrowserHome();
  fs.unlinkSync(getBrowserSettingsPath());
  write(getDeviceMetaPath(), yaml.stringify({ config: { browserRemoteControl: true } }));
  await migrateBrowserHome();
  expect(getConfigValue('browser.remote-control').value).toBe(true);
  expect(yaml.parse(fs.readFileSync(getDeviceMetaPath(), 'utf8')).config ?? {}).toEqual({});
});

it('migration lock timeout warns but keeps help available and prevents daemon startup', async () => {
  seed();
  bindTask('fixture', { device: 'fixture', profile: 'work', createdAt: Date.now() });
  fs.mkdirSync(getBrowserLocalDir(), { recursive: true });
  const release = await lockfile.lock(getBrowserLocalDir(), { lockfilePath: getBrowserMigrationLockPath(), realpath: false });
  try {
    const [help, serve, tabs] = await Promise.all([cli('help', 'tabs', '--json'), cli('__serve'), cli('tabs', '--task', 'fixture')]);
    expect(help.code).toBe(0);
    expect(JSON.parse(help.stdout).name).toBe('tabs');
    expect(help.stderr).toContain('Cannot lock browser migration');
    expect(serve.code).toBe(1);
    expect(tabs.code).toBe(1);
    expect(tabs.stderr).toContain('error: Cannot lock browser migration');
    expect(serve.stderr).toContain('Cannot lock browser migration');
    expect(fs.existsSync(getBrowserSocketPath())).toBe(false);
    expect(fs.existsSync(getBrowserMigrationMarkerPath())).toBe(false);
    expect(fs.statSync(getLegacyBrowserRuntimeDir()).isDirectory()).toBe(true);
  } finally { await release(); }
  const result = await cli('sessions', '--tasks', '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).some((row: { task: string }) => row.task === 'old')).toBe(true);
}, 25_000);
