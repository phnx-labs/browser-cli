import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';

const directory = process.env.AGENTS_HOME!;
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const cdp = new CDPClient();
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 25_000);
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

  const board = join(directory, 'board.html');
  const notes = join(directory, 'notes.html');
  await writeFile(board, '<title>Board</title>');
  await writeFile(notes, '<title>Notes</title>');
  const boardUrl = pathToFileURL(board).href;
  const notesUrl = pathToFileURL(notes).href;

  const viewer = await cdp.send('Target.createTarget', { url: `${boardUrl}#lane-2` }) as { targetId: string };
  const taskTab = await cdp.send('Target.createTarget', { url: notesUrl }) as { targetId: string };
  const other = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const key = 'show@endpoint-0';
  const task = { id: 't', name: 't', profile: key, tabs: { a: taskTab.targetId }, currentTabId: 'a',
    createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  const conn = { cdp, backend: 'cdp', browserType: 'chrome', key, profile: 'show', pid: browser.pid,
    tasks: new Map([['t', task]]), sessionCache: new Map() };
  (service as any).connections.set(key, conn);

  const evaluate = async (id: string, expression: string) => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: id, flatten: true }) as { sessionId: string };
    const value = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as { result: { value: unknown } };
    return value.result.value;
  };
  const pages = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets') as { targetInfos: Array<{ type: string }> };
    return targetInfos.filter((t) => t.type === 'page').length;
  };
  for (let attempt = 0; attempt < 40 && await evaluate(viewer.targetId, 'document.readyState') !== 'complete'; attempt++) await Bun.sleep(25);
  await evaluate(viewer.targetId, 'window.__beforeShow = 1');
  await cdp.send('Target.activateTarget', { targetId: other.targetId });
  assert.equal(await evaluate(viewer.targetId, 'document.visibilityState'), 'hidden');
  const before = await pages();

  const shown = await (service as any).showInCdp(conn, boardUrl, false);
  assert.deepEqual(shown, { tabId: viewer.targetId, reused: true });
  assert.equal(await pages(), before);
  let reloaded = false;
  for (let attempt = 0; attempt < 40 && !reloaded; attempt++) {
    reloaded = await evaluate(viewer.targetId, 'window.__beforeShow === undefined && document.readyState === "complete"') === true;
    if (!reloaded) await Bun.sleep(25);
  }
  assert.ok(reloaded, 'the reused tab must be reloaded');
  assert.equal(await evaluate(viewer.targetId, 'document.visibilityState'), 'visible');
  const reused = 'reused: reloaded and visible';

  const loadedFresh = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await evaluate(viewer.targetId, 'window.__beforeShow === undefined && document.readyState === "complete"') === true) return true;
      await Bun.sleep(25);
    }
    return false;
  };
  for (const round of [1, 2]) {
    await evaluate(viewer.targetId, 'window.__beforeShow = 1');
    const toSection = await (service as any).showInCdp(conn, `${boardUrl}#section-3`, false);
    assert.deepEqual(toSection, { tabId: viewer.targetId, reused: true }, `fragment round ${round}`);
    assert.ok(await loadedFresh(), `fragment round ${round}: the page must reload, not only scroll`);
    assert.equal(await evaluate(viewer.targetId, 'location.hash'), '#section-3');
  }
  assert.equal(await pages(), before);
  const fragment = 'fragment: lands on #section-3 and reloads';

  const realClaimed = (service as any).targetIsClaimed.bind(service);
  let checks = 0;
  (service as any).targetIsClaimed = (c: unknown, id: string) => (id === viewer.targetId && ++checks > 1) || realClaimed(c, id);
  const raced = await (service as any).showInCdp(conn, boardUrl, false);
  (service as any).targetIsClaimed = realClaimed;
  assert.equal(checks, 2, 'the viewer tab is checked once to find it and once more before it is touched');
  assert.equal(raced.reused, false, 'a tab claimed by a task during the lookup is not taken');
  assert.notEqual(raced.tabId, viewer.targetId);
  await cdp.send('Target.closeTarget', { targetId: raced.tabId });
  for (let attempt = 0; attempt < 40 && await pages() !== before; attempt++) await Bun.sleep(25);

  const notesShown = await (service as any).showInCdp(conn, notesUrl, false);
  assert.equal(notesShown.reused, false);
  assert.notEqual(notesShown.tabId, taskTab.targetId);
  assert.equal(await pages(), before + 1);

  const forced = await (service as any).showInCdp(conn, boardUrl, true);
  assert.equal(forced.reused, false);
  assert.notEqual(forced.tabId, viewer.targetId);
  assert.equal(await pages(), before + 2);
  console.log(`${reused}; ${fragment}; claimed mid-lookup: new tab; task tab: left alone; --fresh: new tab`);
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
}
