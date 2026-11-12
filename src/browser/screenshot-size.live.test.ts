import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('a compressed screenshot is CSS pixels on a 2x screen; raw keeps device pixels', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-shot-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/screenshot-size-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe('compressed 800x600, raw 1600x1200');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
