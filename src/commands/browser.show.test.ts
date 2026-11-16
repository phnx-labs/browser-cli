import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const opener = join(import.meta.dir, '..', 'runtime', 'testdata', 'opener');

async function show(...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'browser-show-cli-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'index.ts'), 'show', 'https://example.com/', '--os-browser', ...args], {
      env: { ...process.env, AGENTS_HOME: home, DISPLAY: ':99', PATH: `${opener}:${process.env.PATH}`, SHOW_OPENER_EXIT: '0',
        BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, stdout };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== 'linux')('show --json carries visible and frontmost, and the line never claims the page is in front', async () => {
  const json = await show('--json');
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toEqual({
    via: 'open', visible: false, frontmost: 'unknown', notification: 'none',
    unknownWhy: 'only macOS reports the app in front, and this is linux',
  });
  const line = await show();
  expect(line.code).toBe(0);
  expect(line.stdout.trim()).toBe('Opened in the OS default browser; cannot tell whether the user can see it (only macOS reports the app in front, and this is linux): https://example.com/');
}, 30_000);
