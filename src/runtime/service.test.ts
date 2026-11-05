import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stopLegacyBrowserService } from './service.js';

it('stops the real old-socket process and waits for its graceful exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-old-'));
  const old = process.env.AGENTS_HOME;
  process.env.AGENTS_HOME = home;
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, 'testdata', 'legacy-daemon.cjs'), '__serve'], {
    env: { ...process.env, AGENTS_HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    reader.releaseLock();
    await stopLegacyBrowserService();
    expect(await child.exited).toBe(0);
    expect(fs.readFileSync(path.join(home, '.cache', 'helpers', 'browser', 'stopped'), 'utf8')).toBe('graceful');
    await stopLegacyBrowserService();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    if (old === undefined) delete process.env.AGENTS_HOME; else process.env.AGENTS_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 10_000);

it('treats an old socket path too long to bind as no old service', async () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-long-')), 'x'.repeat(80), 'agents');
  const old = process.env.AGENTS_HOME;
  process.env.AGENTS_HOME = home;
  try {
    const messages: string[] = [];
    expect(await stopLegacyBrowserService(message => messages.push(message))).toBe(true);
    expect(messages).toEqual([]);
  } finally {
    if (old === undefined) delete process.env.AGENTS_HOME; else process.env.AGENTS_HOME = old;
    fs.rmSync(path.dirname(path.dirname(home)), { recursive: true, force: true });
  }
});

it.each(['no-pid', 'hung'])('an old service with %s is probed once, warns, and does not prevent the new daemon starting', async mode => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-stuck-'));
  const old = process.env.AGENTS_HOME;
  process.env.AGENTS_HOME = home;
  const env = { ...process.env, AGENTS_HOME: home, BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined };
  const legacy = Bun.spawn([process.execPath, path.join(import.meta.dir, 'testdata', 'legacy-daemon.cjs'), '__serve', mode], {
    env, stdout: 'pipe', stderr: 'pipe',
  });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const reader = legacy.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    reader.releaseLock();
    const messages: string[] = [];
    const started = Date.now();
    expect(await stopLegacyBrowserService(message => messages.push(message))).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    const again = Date.now();
    expect(await stopLegacyBrowserService(message => messages.push(message))).toBe(false);
    expect(Date.now() - again).toBeLessThan(100);
    expect(messages).toHaveLength(1);
    expect(legacy.exitCode).toBeNull();
    if (mode === 'hung') expect(fs.readFileSync(path.join(home, '.cache', 'helpers', 'browser', 'signals'), 'utf8')).toBe('SIGTERM\n');
    daemon = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'index.ts'), '__serve'], { env, stdout: 'pipe', stderr: 'pipe' });
    const pid = path.join(home, 'browser', 'run', 'service.pid');
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(pid) && daemon.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    expect(daemon.exitCode).toBeNull();
    expect(Number(fs.readFileSync(pid, 'utf8'))).toBe(daemon.pid);
    const { migrateBrowserHome } = await import('./home-migration.js');
    const { BrowserService } = await import('../browser/service.js');
    await migrateBrowserHome(() => {});
    await expect(new BrowserService().start('work')).rejects.toThrow('old browser service');
  } finally {
    if (daemon) { daemon.kill('SIGTERM'); await daemon.exited; }
    legacy.kill('SIGKILL'); await legacy.exited;
    if (old === undefined) delete process.env.AGENTS_HOME; else process.env.AGENTS_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
