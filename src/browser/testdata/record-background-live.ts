import { strict as assert } from 'node:assert';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';

const directory = process.env.AGENTS_HOME!;
const server = Bun.serve({ port: 0, fetch: (req) => new Response(
  `<body style="background:${new URL(req.url).pathname.slice(1) || 'white'}"><h1>${req.url}</h1></body>`,
  { headers: { 'content-type': 'text/html' } }) });
const page = (color: string) => `http://localhost:${server.port}/${color}`;
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const cdp = new CDPClient();
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 40_000);
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
  await cdp.connect(address);
  const earlier = await cdp.send('Target.createTarget', { url: page('red') }) as { targetId: string };
  const later = await cdp.send('Target.createTarget', { url: page('white') }) as { targetId: string };
  const key = 'rec@endpoint-0';
  const task = (name: string, targetId: string) => ({ id: name, name, profile: key, tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid });
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key, profile: 'rec',
    pid: browser.pid, tasks: new Map([['one', task('one', earlier.targetId)], ['two', task('two', later.targetId)]]),
    sessionCache: new Map() });

  await service.recordStart('one', undefined, { fps: 5 });
  const recording = (service as any).recordings.get('one');
  for (const color of ['green', 'blue', 'yellow']) {
    await service.navigate('one', page(color), undefined, { wait: true });
    await Bun.sleep(400);
  }
  const frames = recording.frameCount;
  const stopped = await service.recordStop('one');
  assert.ok(stopped.bytes > 0, 'the background recording has content');
  const distinct = new Set<string>();
  const probe = Bun.spawnSync(['ffmpeg', '-v', 'error', '-i', stopped.path, '-vf', 'scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const raw = probe.stdout;
  for (let i = 0; i + 192 <= raw.length; i += 192) distinct.add(String(raw[i]! >> 6) + (raw[i + 1]! >> 6) + (raw[i + 2]! >> 6));
  assert.ok(frames > 1 && distinct.size >= 4, `earlier task recorded ${distinct.size} distinct colors`);

  await service.recordStart('one', undefined, { fps: 5 });
  const ffmpeg = (service as any).recordings.get('one').ffmpeg;
  await Bun.sleep(1500);
  await service.done('one');
  assert.equal((service as any).recordings.size, 0, 'done finalizes the recording');
  assert.notEqual(ffmpeg.exitCode, null, 'done leaves no encoder running');
  assert.ok((await stat(ffmpeg.spawnargs.at(-1))).size > 0, 'done leaves a finished file');
  console.log(`background recording: ${distinct.size} colors; done: recording finalized`);
} finally {
  clearTimeout(deadline);
  server.stop(true);
  await cdp.close();
  browser.kill();
  await browser.exited;
}
