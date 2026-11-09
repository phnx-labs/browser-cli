import { strict as assert } from 'node:assert';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';
import { uploadTaskDir } from '../upload.js';

const directory = process.env.AGENTS_HOME!;
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  fetch: () => new Response(`<!doctype html><title>Upload</title>
    <input type="file" id="pick" aria-label="Attachment"
      onchange="this.files[0].text().then(t => document.title = this.files[0].name + ':' + t)">`,
    { headers: { 'content-type': 'text/html' } }),
});
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const cdp = new CDPClient();
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 20_000);

try {
  let address = '';
  for (let attempt = 0; attempt < 100 && !address; attempt++) {
    try {
      const [port, endpoint] = (await readFile(join(directory, 'chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
      address = `ws://127.0.0.1:${port}${endpoint}`;
    } catch { await Bun.sleep(50); }
  }
  assert.ok(address, 'Chromium must expose its real CDP endpoint');
  await cdp.connect(address);
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://localhost:${server.port}/` }) as { targetId: string };
  const key = 'upload@endpoint-0';
  const task = { id: 'upload', name: 'upload', profile: key, tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key,
    profile: 'upload', pid: browser.pid, tasks: new Map([['upload', task]]), sessionCache: new Map() });

  const source = join(directory, 'report.txt');
  await writeFile(source, 'hello upload');
  let listing = '';
  for (let attempt = 0; attempt < 100 && !listing.includes('Attachment'); attempt++) {
    listing = (await service.refs('upload')).refs;
    await Bun.sleep(50);
  }
  const ref = Number(/"Attachment" \[ref=(\d+)\]/.exec(listing)![1]);
  const staged = () => existsSync(uploadTaskDir('upload')) ? readdirSync(uploadTaskDir('upload')) : [];
  await assert.rejects(service.upload('upload', ['report.txt'], { ref }), /must be absolute/);
  assert.deepEqual(staged(), [], 'a refused upload keeps no copy');
  assert.equal((await service.upload('upload', [source], { ref, mode: 'drop' })).mode, 'drop');
  assert.deepEqual(staged(), [], 'a drop has read its file, so its copy is gone');
  assert.equal((await service.upload('upload', [source], { ref })).mode, 'input');
  assert.equal(staged().length, 1, 'an input keeps its copy for the page to submit');

  let text = '';
  for (let attempt = 0; attempt < 100 && !text.startsWith('report.txt:'); attempt++) {
    text = await service.text('upload', undefined);
    await Bun.sleep(25);
  }
  assert.match(text, /^report\.txt:hello upload — /);
  await new BrowserService().stop('upload');
  assert.deepEqual(staged(), [], 'a restarted service still removes the task\'s copies when it closes the task');
  await service.upload('upload', [source], { ref });
  assert.equal(staged().length, 1);
  await service.stop('upload');
  assert.deepEqual(staged(), [], 'done removes the task\'s copies');
  console.log('upload: absolute file accepted under its own name; relative path refused; copies removed');
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
  server.stop(true);
}
