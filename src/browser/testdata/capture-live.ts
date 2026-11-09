import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';

const directory = process.env.AGENTS_HOME!;
const site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => new URL(req.url).pathname === '/data.json'
  ? Response.json({ ok: true })
  : new Response('<title>capture</title>', { headers: { 'content-type': 'text/html' } }) });
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const cdp = new CDPClient();
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 15_000);
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
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${site.port}/` }) as { targetId: string };
  const key = 'capture@endpoint-0';
  const task = { id: 'capture', name: 'capture', profile: key, tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key,
    profile: 'capture', pid: browser.pid, tasks: new Map([['capture', task]]), sessionCache: new Map() });
  await service.getConsoleLogs('capture');
  await service.getNetworkRequests('capture');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
  await cdp.send('Runtime.evaluate', { expression:
    "console.warn('captured', 1); fetch('/data.json'); setTimeout(() => { throw new Error('thrown on purpose'); })" }, sessionId);
  let logs: Awaited<ReturnType<BrowserService['getConsoleLogs']>> = [];
  let errors: Awaited<ReturnType<BrowserService['getErrors']>> = [];
  let requests: Awaited<ReturnType<BrowserService['getNetworkRequests']>> = [];
  for (let attempt = 0; attempt < 40 && !(logs.length && errors.length && requests.some(r => r.status)); attempt++) {
    await Bun.sleep(50);
    [logs, errors, requests] = await Promise.all([
      service.getConsoleLogs('capture'), service.getErrors('capture'), service.getNetworkRequests('capture')]);
  }
  assert.deepEqual(logs.map(l => [l.level, l.text]), [['warn', 'captured 1']]);
  assert.match(errors[0]?.message ?? '', /thrown on purpose/);
  const fetched = requests.find(r => r.url.endsWith('/data.json'));
  assert.equal(fetched?.status, 200);
  assert.equal(await service.getResponseBody('capture', 'data.json', { timeout: 2000 }), '{"ok":true}');
  console.log('console, errors, requests and response body captured from the task tab');
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
  site.stop(true);
}
