// `browser pdf <output>` saved under sessions/<task>/ whatever path it was given.
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProfile } from '../profiles.js';

const directory = process.env.AGENTS_HOME!;
const entry = join(import.meta.dir, '..', '..', 'index.ts');
mkdirSync(join(directory, 'work'), { recursive: true });
const work = realpathSync(join(directory, 'work'));
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--password-store=basic', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 50_000);

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, entry, ...args], { cwd: work, env: process.env });
  return { code: run.exitCode, stdout: run.stdout.toString().trim(), stderr: run.stderr.toString() };
}

const isPdf = (file: string) => readFileSync(file).subarray(0, 5).toString() === '%PDF-';

try {
  let address = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [port, endpoint] = (await readFile(join(directory, 'chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
      address = `ws://127.0.0.1:${port}${endpoint}`;
      break;
    } catch { await Bun.sleep(50); }
  }
  assert.ok(address, 'Chromium must expose its real CDP endpoint');
  await createProfile({ name: 'pdf', browser: 'custom', binary: process.argv[2]!, endpoints: [address], launchPolicy: 'attach-only' });

  const started = cli('start', '--profile', 'pdf', '--task', 'p', '--url', 'data:text/html,<title>pdf</title><h1>pdf</h1>', '--no-skills');
  assert.equal(started.code, 0, started.stderr);

  const relative = cli('pdf', 'rel.pdf', '--task', 'p');
  assert.equal(relative.code, 0, relative.stderr);
  assert.equal(relative.stdout, join(work, 'rel.pdf'));
  assert.ok(isPdf(join(work, 'rel.pdf')), 'a relative path is a PDF in the caller\'s directory');

  const absolutePath = join(realpathSync(directory), 'out', 'abs.pdf');
  const absolute = cli('pdf', absolutePath, '--task', 'p');
  assert.equal(absolute.code, 0, absolute.stderr);
  assert.equal(absolute.stdout, absolutePath);
  assert.ok(isPdf(absolutePath), 'an absolute path in a new folder is a PDF');

  const automatic = cli('pdf', '--task', 'p');
  assert.equal(automatic.code, 0, automatic.stderr);
  assert.match(automatic.stdout, /[/\\]sessions[/\\]p[/\\][^/\\]+\.pdf$/);
  assert.ok(isPdf(automatic.stdout), 'no path still saves a PDF under the task');
  assert.match(automatic.stderr, /Tip: auto-saving to /);

  console.log('pdf: relative and absolute paths honored; no path saves under the task');
} finally {
  cli('done', '--task', 'p');
  cli('stop', '--service');
  clearTimeout(deadline);
  browser.kill();
  await browser.exited;
}
