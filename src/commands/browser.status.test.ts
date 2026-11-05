import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { ipcEndpoint } from '../runtime/platform.js';

it('status bounds an unresponsive service and distinguishes it from an absent service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-status-'));
  const helperDir = root;
  mkdirSync(join(helperDir, 'browser', 'run'), { recursive: true });
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => clients.delete(socket));
  });
  const endpoint = ipcEndpoint(join(helperDir, 'browser', 'run', 'browser.sock'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  const run = async (helpers: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'index.ts'), 'status', '--json'], {
      env: { ...process.env, AGENTS_HOME: helpers, BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill(), 8_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stderr).toBe('');
      expect(code).toBe(1);
      return JSON.parse(stdout);
    } finally { clearTimeout(timer); }
  };
  try {
    const start = Date.now();
    const unresponsive = await run(helperDir);
    expect(Date.now() - start).toBeLessThan(7_000);
    expect(unresponsive.service.state).toBe('unknown');
    expect(unresponsive.running).toBeUndefined();
    expect(unresponsive.error).toContain('timed out after 3000ms');
    const absent = await run(join(root, 'absent'));
    expect(absent.service.state).toBe('stopped');
    expect(absent.running).toBe(false);
  } finally {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
