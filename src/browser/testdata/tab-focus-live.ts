import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';

const directory = process.env.AGENTS_HOME!;
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
  const first = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const second = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const key = 'focus@endpoint-0';
  const task = { id: 'focus', name: 'focus', profile: key, tabs: { a: first.targetId, b: second.targetId },
    currentTabId: 'b', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key,
    profile: 'focus', pid: browser.pid, tasks: new Map([['focus', task]]), sessionCache: new Map() });
  const visibility = async (id: string) => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: id, flatten: true }) as { sessionId: string };
    const value = await cdp.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, sessionId) as { result: { value: string } };
    return value.result.value;
  };
  await cdp.send('Target.activateTarget', { targetId: second.targetId });
  assert.equal(await visibility(first.targetId), 'hidden');
  await service.tabFocus('focus', 'a');
  assert.equal(await visibility(first.targetId), 'visible');
  assert.equal(await visibility(second.targetId), 'hidden');
  assert.equal(task.currentTabId, 'a');
  await cdp.send('Target.closeTarget', { targetId: second.targetId });
  let removed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const { targetInfos } = await cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string }> };
    if (!targetInfos.some(target => target.targetId === second.targetId)) { removed = true; break; }
    await Bun.sleep(25);
  }
  assert.ok(removed, 'Closed target must disappear before testing failed activation');
  await assert.rejects(service.tabFocus('focus', 'b'));
  assert.equal(task.currentTabId, 'a');
  console.log('focus: visible; sibling: hidden; failed activation: selection preserved');
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
}
