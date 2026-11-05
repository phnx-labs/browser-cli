import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emit, emitBrowserAction, REPEAT_QUIET_MS, rotateDaemonLog } from './events.js';
import { actionsDir } from './session-store.js';
import { getBrowserDaemonLogPath } from './state.js';

let home: string;
const previous = process.env.AGENTS_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-events-'));
  process.env.AGENTS_HOME = home;
});

afterEach(() => {
  setSystemTime();
  if (previous === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

function daemonLines(file = getBrowserDaemonLogPath()): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('daemon log', () => {
  it('writes one JSON line per event with ts first', () => {
    emit('browser.launch', { profile: 'work', task: 'login', pid: 42 });
    const [line] = daemonLines();
    expect(Object.keys(line)[0]).toBe('ts');
    expect(line).toMatchObject({ event: 'browser.launch', profile: 'work', task: 'login', pid: 42 });
    expect(Number.isNaN(Date.parse(line.ts as string))).toBe(false);
    expect(fs.statSync(getBrowserDaemonLogPath()).mode & 0o777).toBe(0o600);
  });

  it('logs a repeated failure once, then at each power of ten with its count', () => {
    for (let i = 0; i < 12; i++) emit('reaper.failed', { task: 'a', profile: 'arc', error: 'Owned Arc tab has no stable id' });
    emit('reaper.failed', { task: 'b', profile: 'arc', error: 'Owned Arc tab has no stable id' });
    emit('reaper.closed', { task: 'c', profile: 'arc', reason: 'idle' });
    emit('reaper.closed', { task: 'c', profile: 'arc', reason: 'idle' });
    expect(daemonLines().map((l) => [l.event, l.task, l.count])).toEqual([
      ['reaper.failed', 'a', undefined],
      ['reaper.failed', 'a', 10],
      ['reaper.failed', 'b', undefined],
      ['reaper.closed', 'c', undefined],
      ['reaper.closed', 'c', undefined],
    ]);
  });

  it('starts a repeated failure over once it has been quiet for ten minutes', () => {
    const start = Date.parse('2026-10-27T12:00:00Z');
    const fail = () => emit('reaper.failed', { task: 'flaky', profile: 'arc', error: 'tab gone' });
    setSystemTime(new Date(start));
    fail();
    setSystemTime(new Date(start + REPEAT_QUIET_MS - 1000));
    fail();
    setSystemTime(new Date(start + 2 * REPEAT_QUIET_MS + 1000));
    fail();
    expect(daemonLines().map((l) => [l.ts, l.count])).toEqual([
      ['2026-10-27T12:00:00.000Z', undefined],
      ['2026-10-27T12:20:01.000Z', undefined],
    ]);
  });

  it('rolls an oversized log to .1 at start and keeps three', () => {
    const file = getBrowserDaemonLogPath();
    rotateDaemonLog(10, 3);
    expect(fs.existsSync(file)).toBe(false);
    for (const generation of ['g1', 'g2', 'g3', 'g4']) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${generation}${'x'.repeat(20)}\n`);
      rotateDaemonLog(10, 3);
    }
    fs.writeFileSync(file, 'small\n');
    rotateDaemonLog(10, 3);
    expect(fs.readFileSync(file, 'utf8')).toBe('small\n');
    expect([1, 2, 3].map((i) => fs.readFileSync(`${file}.${i}`, 'utf8').slice(0, 2))).toEqual(['g4', 'g3', 'g2']);
    expect(fs.existsSync(`${file}.4`)).toBe(false);
  });
});

describe('logged URLs', () => {
  const url = 'https://user:pass@auth.example.com/callback?code=secret&token=t#access_token=x';

  it('keep origin and path only, in the daemon log and the action log', () => {
    emit('browser.navigate', { task: 't', url });
    emit('browser.navigate', { task: 't', url: 'not a url' });
    emitBrowserAction('navigate', { task: 't', url }, {});
    expect(daemonLines().map((l) => l.url)).toEqual(['https://auth.example.com/callback', undefined]);
    const [action] = daemonLines(path.join(actionsDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`));
    expect(action.url).toBe('https://auth.example.com/callback');
    expect(JSON.stringify(action)).not.toContain('secret');
  });

  it('keep only the scheme of a data: or javascript: URL', () => {
    emit('browser.navigate', { task: 't', url: 'data:text/html,<b>secret</b>' });
    emit('browser.navigate', { task: 't', url: 'javascript:leak("secret")' });
    expect(daemonLines().map((l) => l.url)).toEqual(['data:', 'javascript:']);
  });
});
