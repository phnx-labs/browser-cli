import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { getCentralMetaPath, updateMeta, withMetaLock } from './state.js';
import { setConfigValue } from './device-config.js';

let home: string;
const previous = process.env.AGENTS_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-lock-'));
  process.env.AGENTS_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('withMetaLock', () => {
  it('leaves nothing at agents.yaml.lock after a write', () => {
    updateMeta({ browser: { a: { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] } } });
    expect(fs.existsSync(`${getCentralMetaPath()}.lock`)).toBe(false);
    expect(fs.readFileSync(getCentralMetaPath(), 'utf8')).toContain('cdp://127.0.0.1:9222');
  });

  it('removes the plain lock file older builds left behind, then locks', () => {
    fs.writeFileSync(getCentralMetaPath(), '');
    fs.writeFileSync(`${getCentralMetaPath()}.lock`, '88048');
    expect(withMetaLock(() => 'ran')).toBe('ran');
    expect(fs.existsSync(`${getCentralMetaPath()}.lock`)).toBe(false);
  });

  it('waits for a peer holding the lock the way agents-cli does', async () => {
    fs.writeFileSync(getCentralMetaPath(), '');
    // The peer runs in a real separate process, like the agents-cli daemon.
    const peer = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const l = require('proper-lockfile');
         const release = l.lockSync(${JSON.stringify(getCentralMetaPath())}, { stale: 5000, realpath: true });
         console.log('locked');
         setTimeout(() => { release(); console.log('released'); }, 600);`,
      ],
      { cwd: import.meta.dirname, stdout: 'pipe' },
    );
    const reader = peer.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('locked');
    expect(lockfile.checkSync(getCentralMetaPath(), { realpath: true })).toBe(true);

    const started = Date.now();
    const waited = withMetaLock(() => Date.now() - started);
    expect(waited).toBeGreaterThanOrEqual(400);
    await peer.exited;
    expect(fs.existsSync(`${getCentralMetaPath()}.lock`)).toBe(false);
  });

  it('does not leave an empty agents.yaml for a write that never touches it', () => {
    // agents-cli runs its first-run setup only while agents.yaml is missing.
    setConfigValue('browser.task-idle-minutes', 10);
    expect(fs.existsSync(getCentralMetaPath())).toBe(false);
    expect(fs.existsSync(`${getCentralMetaPath()}.lock`)).toBe(false);
  });

  it('survives a peer breaking the lock mid-write: release fails quietly, the result stands', () => {
    fs.writeFileSync(getCentralMetaPath(), '');
    const result = withMetaLock(() => {
      // What a peer's stale-break does: remove the lock directory we hold.
      fs.rmdirSync(`${fs.realpathSync(getCentralMetaPath())}.lock`);
      return 'written';
    });
    expect(result).toBe('written');
  });
});

describe('offered profile writes', () => {
  it('does not publish an empty declaration for settings-only machines or rewrite unchanged offers', async () => {
    const { getBrowserProfilesPath } = await import('./state.js');
    updateMeta({ deviceConfig: { browserViewer: 'os' } });
    expect(fs.existsSync(getBrowserProfilesPath())).toBe(false);
    updateMeta({ deviceBrowser: { work: { browser: 'chromium', endpoints: ['cdp://localhost:9222'] } } });
    const file = getBrowserProfilesPath();
    fs.utimesSync(file, new Date(2000), new Date(2000));
    const before = fs.statSync(file);
    updateMeta({ deviceConfig: { browserViewer: 'work' } });
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(fs.statSync(file).ino).toBe(before.ino);
  });

  it('keeps atomic-write temporary files outside the tracked profile directory', async () => {
    const { getBrowserProfilesDir, getBrowserLocalDir } = await import('./state.js');
    fs.mkdirSync(getBrowserProfilesDir(), { recursive: true });
    const names: string[] = [];
    const watcher = fs.watch(getBrowserProfilesDir(), (_event, file) => { if (file) names.push(String(file)); });
    try {
      updateMeta({ deviceBrowser: { work: { browser: 'chromium', endpoints: ['cdp://localhost:9222'] } } });
      await Bun.sleep(30);
      expect(names.length).toBeGreaterThan(0);
      expect(names.every(name => name.endsWith('.yaml'))).toBe(true);
      expect(fs.readdirSync(getBrowserLocalDir()).some(name => name.startsWith('yaml-'))).toBe(false);
    } finally { watcher.close(); }
  });
});
