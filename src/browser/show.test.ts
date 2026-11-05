import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameShownPage } from './service.js';

describe('sameShownPage', () => {
  test('ignores the fragment and a trailing slash', () => {
    expect(sameShownPage('https://example.com/report#section-2', 'https://example.com/report')).toBe(true);
    expect(sameShownPage('https://example.com/report/', 'https://example.com/report')).toBe(true);
    expect(sameShownPage('https://example.com', 'https://example.com/')).toBe(true);
    expect(sameShownPage('file:///tmp/a%20b/board.html#top', 'file:///tmp/a%20b/board.html')).toBe(true);
  });

  test('keeps the query, path, host and scheme', () => {
    expect(sameShownPage('https://example.com/report?v=1', 'https://example.com/report?v=2')).toBe(false);
    expect(sameShownPage('https://example.com/report', 'https://example.com/reports')).toBe(false);
    expect(sameShownPage('https://example.com/report', 'http://example.com/report')).toBe(false);
    expect(sameShownPage('file:///tmp/board.html', 'file:///tmp/other.html')).toBe(false);
  });
});

const chrome = process.env.AGENTS_TEST_CHROME;

test.skipIf(!chrome)('show reloads and focuses the tab already showing the page, never a task tab', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-show-'));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'testdata/show-reuse-live.ts'), chrome!], {
      env: { ...process.env, AGENTS_HOME: directory },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    expect(output.trim()).toBe('reused: reloaded and visible; fragment: lands on #section-3 and reloads; claimed mid-lookup: new tab; task tab: left alone; --fresh: new tab');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
