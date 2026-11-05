// Three agents call `start` on one real Chromium at the same moment, before any
// connection to it exists. Each must keep its task: before the per-key lock in
// openConnection, every start opened its own connection and the last one
// registered replaced the others, so the earlier tasks were "not found".
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { createProfile } from '../profiles.js';

const directory = process.env.AGENTS_HOME!;
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 25_000);
const page = (title: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><p>${title} page</p>`)}`;

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
  await createProfile({ name: 'race', browser: 'custom', binary: process.argv[2]!, endpoints: [address], launchPolicy: 'attach-only' });

  const service = new BrowserService();
  const names = ['shop', 'form', 'checkout'];
  const started = await Promise.all(names.map((name) => service.start('race', { url: page(name) })));
  assert.equal(new Set(started.map((s) => s.task)).size, 3, 'three distinct tasks');
  for (const [i, s] of started.entries()) {
    const text = await service.text(s.task, undefined);
    assert.ok(text.includes(`${names[i]} page`), `task ${s.task} reads its own page, got: ${text.slice(0, 120)}`);
  }
  for (const s of started) await service.done(s.task);
  console.log('three concurrent starts: three tasks, each on its own page');
} finally {
  clearTimeout(deadline);
  browser.kill();
}
process.exit(0);
