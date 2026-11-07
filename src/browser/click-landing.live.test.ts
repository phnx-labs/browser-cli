import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('a click says how it landed, and text loads lazy parts first', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-land-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/click-landing-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory, AGENTS_HISTORY_DIR: join(directory, '.history') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe(
      'plain: one mouse click; scrolled: one mouse click; covered: named, clicked in the DOM; swallowed: reported, never repeated; pressed only: reported, never repeated; no mouse: clicked in the DOM instead, once; hover opens a cover: clicked in the DOM instead, once; busy page: lazy step gives way; closed shadow: one mouse click; same-site iframe: one mouse click; disabled and fieldset-disabled: refused; label: its control counts; lazy: loaded, scroll restored; hidden: no wait; stuck: reported, scroll restored',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
