import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('refs fast paths: editor gate, cached-ref click, heal fallback, snapshot, Enter submits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-refs-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/refs-fast-path-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe(
      'gate: one question, zero walks; click: partial check only; replaced node: healed; snapshot: destination; editor: detected; enter: submitted; router click: settled; wait: settled; relabeled: same element',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
