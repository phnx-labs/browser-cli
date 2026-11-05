import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { pickerHeader } from './browser-sessions-picker.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sessions-cli-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, 'src/index.ts', 'sessions', ...args], {
    env: { ...process.env, HOME: root, AGENTS_HOME: root, AGENTS_HISTORY_DIR: join(root, 'history'),
      BROWSER_CONTEXT_FD: undefined },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
it('preserves flat capture JSON and adds searchable task JSON without Sessions installed', async () => {
  const captures = join(root, 'browser/cache/work/sessions/review');
  mkdirSync(captures, { recursive: true });
  writeFileSync(join(captures, 'example.png'), 'fixture capture');
  const flat = await run('--json');
  expect(flat.exit).toBe(0);
  expect(JSON.parse(flat.stdout)).toMatchObject([{ profile: 'work', artifacts: [{ name: 'example.png', task: 'review' }] }]);
  expect(JSON.parse(flat.stdout)[0].task).toBeUndefined();
  const tasks = await run('--tasks', '--search', 'review', '--json');
  expect(tasks.exit).toBe(0);
  expect(JSON.parse(tasks.stdout)).toMatchObject([{ task: 'review', counts: { screenshot: 1 } }]);
  const missing = await run('--search', 'different', '--open', 'latest');
  expect(missing.exit).toBe(1);
  expect(missing.stderr).toContain('No capture matching');
});
it('imports legacy summaries through the CLI, survives removal of the source, and reports errors', async () => {
  const source = join(root, 'legacy.db');
  const db = new Database(source);
  db.exec('CREATE TABLE browser_sessions (profile TEXT, task TEXT, started_at INTEGER, last_activity INTEGER)');
  db.query('INSERT INTO browser_sessions VALUES(?,?,?,?)').run('work', 'finished', Date.now(), Date.now());
  db.close();
  const imported = await run('migrate', '--from', source, '--json');
  expect(imported.exit).toBe(0);
  expect(JSON.parse(imported.stdout)).toEqual({ imported: 1 });
  rmSync(source);
  expect(JSON.parse((await run('--tasks', '--json')).stdout)).toMatchObject([{ task: 'finished', artifacts: [] }]);
  writeFileSync(source, 'corrupt');
  expect((await run('migrate', '--from', source, '--json')).exit).toBe(1);
});

const DAY = 86_400_000;
function capture(profile: string, task: string, name: string, ageMs: number) {
  const dir = join(root, 'browser', 'cache', profile, 'sessions', task);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, 'fixture capture');
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
}
it('filters captures and task rows by --since/--until on last activity', async () => {
  capture('work', 'fresh', 'fresh.png', 60_000);
  capture('work', 'week', 'week.png', 8 * DAY);
  capture('work', 'old', 'old.png', 60 * DAY);
  const names = (out: string) => JSON.parse(out).flatMap((g: { artifacts: { name: string }[] }) => g.artifacts.map(a => a.name));
  expect(names((await run('--json', '--since', '7d')).stdout)).toEqual(['fresh.png']);
  expect(names((await run('--json', '--since', '1mo', '--until', '7d')).stdout)).toEqual(['week.png']);
  expect(names((await run('--json', '--until', new Date(Date.now() - 30 * DAY).toISOString())).stdout)).toEqual(['old.png']);
  const tasks = await run('--tasks', '--json', '--since', '1mo');
  expect(JSON.parse(tasks.stdout).map((r: { task: string }) => r.task)).toEqual(['fresh', 'week']);
  const flat = await run('--tasks', '--since', '1mo');
  expect(flat.stdout.trim().split('\n').map(line => line.split('  ')[0])).toEqual(['fresh', 'week']);
  expect((await run('--no-interactive', '--until', '2000-01-01')).stdout.trim()).toBe('No browser captures match --since/--until.');
  expect((await run('--tasks', '--until', '2000-01-01')).stdout.trim()).toBe('No browser tasks or captures match --since/--until.');
  const kept = JSON.parse((await run('--json', '--profile', 'work', '--until', '2000-01-01')).stdout);
  expect(kept).toMatchObject([{ profile: 'work', artifacts: [] }]);
  const opened = await run('--open', 'latest', '--until', '7d');
  expect(opened.stdout.split('\n')[0]).toEndWith('week.png');
  expect((await run('--open', 'old.png', '--since', '7d')).exit).toBe(1);
});
it('caps the flat listing at --limit, defaulting to 50, and --json only when --limit is given', async () => {
  for (let i = 0; i < 55; i++) capture('work', `t${i}`, `c${i}.png`, (i + 1) * 60_000);
  const byDefault = await run('--no-interactive');
  expect(byDefault.stdout.match(/c\d+\.png/g)!.length).toBe(50);
  expect(byDefault.stderr).toContain('Showing 50 of 55 captures. --limit 55 or --json to see all, --profile or --since to narrow.');
  expect(byDefault.stdout).not.toContain('--limit');
  const tasks = await run('--tasks', '--limit', '3');
  expect(tasks.stdout.trim().split('\n').map(line => line.split('  ')[0])).toEqual(['t0', 't1', 't2']);
  expect(tasks.stdout.split('\n')[0]).toEndWith('  1 min ago');
  expect(tasks.stderr).toContain('Showing 3 of 55 tasks. --limit 55 or --json to see all, --search or --since to narrow.');
  expect(JSON.parse((await run('--tasks', '--json')).stdout)).toHaveLength(55);
  expect(JSON.parse((await run('--tasks', '--json', '--limit', '2')).stdout)).toHaveLength(2);
  const flatJson = JSON.parse((await run('--json', '--limit', '4')).stdout);
  expect(flatJson[0].artifacts.map((a: { name: string }) => a.name)).toEqual(['c0.png', 'c1.png', 'c2.png', 'c3.png']);
});
it('exits 2 with a clear message on an invalid --since, --until or --limit', async () => {
  for (const [flag, value, message] of [
    ['--since', '7days', 'Invalid --since value "7days": use a relative age (2h, 7d, 4w, 1mo, 1y) or an ISO date.'],
    ['--until', 'later', 'Invalid --until value "later"'],
    ['--limit', '0', 'Invalid --limit value "0": use a positive integer.'],
    ['--limit', ' 5', 'Invalid --limit value " 5": use a positive integer.'],
  ]) {
    const result = await run('--json', flag, value);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe('');
  }
});
it('names the active filters in the picker header', () => {
  expect(pickerHeader({})).toBe('Browser history:');
  expect(pickerHeader({ since: '7d', until: '2026-10-01', search: 'x' })).toBe('Browser history (since 7d · until 2026-10-01 · search "x"):');
});
