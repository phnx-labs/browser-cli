import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('pdf writes to the path it is given, and to the task folder when none is given', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-pdf-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/pdf-output-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe('pdf: relative and absolute paths honored; no path saves under the task');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
