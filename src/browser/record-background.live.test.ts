import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;
const ffmpeg = Bun.which('ffmpeg');

test.skipIf(!chrome || !ffmpeg)('a task whose tab is not selected records its own paints, and done finalizes the file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-record-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/record-background-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe('background recording: 4 colors; done: recording finalized');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
