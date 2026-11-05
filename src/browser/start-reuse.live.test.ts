import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('start returns on the loaded page and a repeated start keeps the session task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-reuse-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/start-reuse-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe('start settles; a second start goes on in the session task');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
