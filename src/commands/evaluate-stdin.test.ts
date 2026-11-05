import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entry = path.join(import.meta.dir, '..', 'index.ts');

/** Run `browser evaluate …` with stdin left open and silent unless `input` is given. */
function evaluate(args: string[], input?: string): Promise<{ code: number | null; stderr: string; ms: number }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-eval-stdin-'));
  const started = Date.now();
  const child = spawn(process.execPath, [entry, 'evaluate', ...args], {
    env: { ...process.env, HOME: home, AGENTS_HOME: home, AGENTS_BROWSER_TASK: '' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (input !== undefined) child.stdin.end(input);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 10_000);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      fs.rmSync(home, { recursive: true, force: true });
      resolve({ code, stderr, ms: Date.now() - started });
    });
  });
}

// A harness can hand the CLI an open pipe it never writes to. Reading stdin
// without being asked would block on it until the harness gave up.
it('a bare evaluate on an open, silent stdin fails at once instead of reading it', async () => {
  const bare = await evaluate([]);
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain('--file - for a script on stdin');
  expect(bare.ms).toBeLessThan(8_000);
});

it('evaluate --file - with nothing on stdin says so', async () => {
  const empty = await evaluate(['--file', '-'], '');
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain('--file - read nothing from stdin');
});
