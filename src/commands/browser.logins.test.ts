import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../runtime/sqlite.js';

// Far-future Chromium expiry (microseconds since 1601), above 2^53 like real ones.
const FUTURE = 14000000000000000n;
const COOKIE_VALUE = 'cookie-value-must-not-leak';
const PASSWORD_VALUE = 'password-must-not-leak';

let root: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'browser-logins-'));
  env = {
    ...process.env,
    HOME: root,
    AGENTS_HOME: join(root, '.agents'),
    AGENTS_SYNC_MACHINE_ID: 'this-box',
    AGENTS_ARC_DIR: join(root, 'Library', 'Application Support', 'Arc'),
    AGENTS_COMET_DIR: join(root, 'Library', 'Application Support', 'Comet'),
    BROWSER_CONTEXT_FD: undefined,
    BROWSER_EVENTS_FD: undefined,
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function browser(...args: string[]): Promise<string> {
  return browserOn(env, ...args);
}

async function browserOn(env: Record<string, string | undefined>, ...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'index.ts'), ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`browser ${args.join(' ')} exited ${code}: ${stderr}`);
  return stdout;
}

function chromeData(profile: string): string {
  const dir = join(root, '.agents', 'browser', 'cache', profile, 'chrome-data', 'Default');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCookies(profile: string, rows: Array<{ host: string; name: string }>): void {
  writeCookiesAt(join(chromeData(profile), 'Cookies'), rows);
}

function writeCookiesAt(file: string, rows: Array<{ host: string; name: string }>): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const db = new Database(file);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)');
  const insert = db.prepare('INSERT INTO cookies (host_key, name, value, encrypted_value, expires_utc) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.host, r.name, COOKIE_VALUE, null, FUTURE);
  db.close();
}

function writeSavedLogin(profile: string, origin: string, username: string): void {
  writeSavedLoginAt(chromeData(profile), origin, username);
}

function writeSavedLoginAt(dir: string, origin: string, username: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'Login Data'));
  db.exec('CREATE TABLE logins (origin_url TEXT, username_value TEXT, signon_realm TEXT, blacklisted_by_user INTEGER, password_value BLOB)');
  db.prepare('INSERT INTO logins VALUES (?, ?, ?, 0, ?)').run(origin, username, origin, PASSWORD_VALUE);
  db.close();
}

async function addProfile(name: string, port: number): Promise<void> {
  await browser('profiles', 'create', name, '--browser', 'custom', '--binary', process.execPath, '-e', `cdp://127.0.0.1:${port}`);
}

it('logins --json prints [] with no profiles and with profiles that have no detected login', async () => {
  expect(JSON.parse(await browser('profiles', 'logins', '--json'))).toEqual([]);
  await addProfile('empty', 9411);
  writeCookies('empty', [{ host: '.example.com', name: 'session' }]);
  expect(JSON.parse(await browser('profiles', 'logins', '--json'))).toEqual([]);
}, 30_000);

it('logins --json emits one flat row per detected service, with its account, and no secret values; an unlaunched profile says so', async () => {
  await addProfile('work', 9412);
  writeCookies('work', [
    { host: '.github.com', name: 'user_session' },
    { host: '.x.com', name: 'auth_token' },
  ]);
  writeSavedLogin('work', 'https://github.com/session', 'octo');
  await addProfile('idle', 9413);

  const out = await browser('profiles', 'logins', '--json');
  expect(JSON.parse(out)).toEqual([
    { profile: 'work', service: 'x', account: '' },
    { profile: 'work', service: 'github', account: 'octo' },
    { profile: 'idle', service: null, account: null, unread: 'never launched on this machine' },
  ]);
  expect(out).not.toContain(COOKIE_VALUE);
  expect(out).not.toContain(PASSWORD_VALUE);

  const table = await browser('profiles', 'logins');
  expect(table).toContain('github      octo');
  expect(table).toContain('idle                (not read: never launched on this machine)');
}, 30_000);

/** A browser user-data dir whose Local State lists `profiles` (dir → display name). */
function writeLocalState(userDataDir: string, profiles: Record<string, string>): void {
  mkdirSync(userDataDir, { recursive: true });
  const infoCache = Object.fromEntries(Object.entries(profiles).map(([dir, name]) => [dir, { name }]));
  writeFileSync(join(userDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }));
}

it('logins reads Arc and Comet profiles from their own user-data dirs, and says why a store is not read', async () => {
  // Arc, laid out like ~/Library/Application Support/Arc: display names map to
  // profile dirs through Local State, the sidebar binds Spaces to profiles.
  const arc = env.AGENTS_ARC_DIR!;
  writeLocalState(join(arc, 'User Data'), {
    Default: 'Your Arc',
    'Profile 1': 'Work',
    'Profile 2': 'Fresh',
    'Profile 3': '__ARC_SYSTEM_PROFILE',
  });
  writeFileSync(join(arc, 'StorableSidebar.json'), JSON.stringify({
    version: 1,
    sidebar: { containers: [{ spaces: ['s1', { id: 's1', title: 'Home', profile: { default: true } }] }] },
  }));
  writeCookiesAt(join(arc, 'User Data', 'Default', 'Network', 'Cookies'), [{ host: '.google.com', name: 'SID' }]);
  writeCookiesAt(join(arc, 'User Data', 'Profile 1', 'Cookies'), [
    { host: 'github.com', name: 'user_session' },
    { host: '.x.com', name: 'auth_token' },
  ]);
  writeSavedLoginAt(join(arc, 'User Data', 'Profile 1'), 'https://github.com/session', 'work-octo');

  // Comet, laid out like ~/Library/Application Support/Comet.
  const comet = env.AGENTS_COMET_DIR!;
  writeLocalState(comet, { Default: 'Person 1' });
  writeCookiesAt(join(comet, 'Default', 'Cookies'), [{ host: '.linkedin.com', name: 'li_at' }]);
  writeSavedLoginAt(join(comet, 'Default'), 'https://www.linkedin.com/login', 'comet-member');

  // A profile whose browser runs on another host, and one declared on another device.
  await browser('profiles', 'create', 'remote', '--browser', 'custom', '--binary', process.execPath, '-e', 'ssh://far-host?port=9555');
  await browserOn({ ...env, AGENTS_SYNC_MACHINE_ID: 'other-box' }, 'profiles', 'create', 'elsewhere', '--browser', 'custom', '--binary', process.execPath, '-e', 'cdp://127.0.0.1:9556');

  const out = await browser('profiles', 'logins', '--json');
  const rows = JSON.parse(out);
  const fresh = join(arc, 'User Data', 'Profile 2');
  expect(rows).toHaveLength(7);
  expect(rows).toEqual(expect.arrayContaining([
    { profile: 'arc-your-arc', service: 'google', account: '' },
    { profile: 'arc-work', service: 'x', account: '' },
    { profile: 'arc-work', service: 'github', account: 'work-octo' },
    { profile: 'arc-fresh', service: null, account: null, unread: `no cookie store in ${fresh}` },
    { profile: 'comet-person-1', service: 'linkedin', account: 'comet-member' },
    { profile: 'remote', service: null, account: null, unread: 'browser runs on far-host over ssh' },
    { profile: 'elsewhere', service: null, account: null, unread: 'declared on other-box, not this machine' },
  ]));
  expect(out).not.toContain(COOKIE_VALUE);
  expect(out).not.toContain(PASSWORD_VALUE);

  const table = await browser('profiles', 'logins');
  expect(table).toContain('arc-work            x');
  expect(table).toContain('github      work-octo');
  expect(table).toContain('remote              (not read: browser runs on far-host over ssh)');

  const show = await browser('profiles', 'show', 'arc-work');
  expect(show).toContain('github     logged in as work-octo');
}, 30_000);
