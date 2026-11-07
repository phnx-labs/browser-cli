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
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 40_000);
const page = (title: string, body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>${body}`)}`;
const count = `<script>window.n = 0; const hit = () => { document.title = 'clicks ' + (++window.n); };</script>`;

try {
  let address = '';
  for (let attempt = 0; attempt < 100 && !address; attempt++) {
    try {
      const [port, endpoint] = (await readFile(join(directory, 'chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
      address = `ws://127.0.0.1:${port}${endpoint}`;
    } catch { await Bun.sleep(50); }
  }
  await cdp.connect(address);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  const task = { id: 'land', name: 'land', profile: 'land@endpoint-0', tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set('land@endpoint-0', { cdp, backend: 'cdp', browserType: 'chrome', key: 'land@endpoint-0',
    profile: 'land', pid: browser.pid, tasks: new Map([['land', task]]), sessionCache: new Map() });
  const title = async () => String(await service.evaluate('land', undefined, 'document.title'));
  const open = async (url: string) => {
    await service.navigate('land', url);
    return (await service.refs('land')).refs;
  };
  const ref = (refs: string, label: string) => Number(new RegExp(`${label} \\[ref=(\\d+)\\]`).exec(refs)![1]);
  const results: string[] = [];

  let refs = await open(page('Plain', `${count}<button onclick="hit()">Buy</button>`));
  let clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('plain: one mouse click');

  refs = await open(page('Covered', `${count}<button onclick="hit()">Buy</button>
    <div id="veil" style="position:fixed;inset:0;background:#0001">Accept cookies</div>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, 'div#veil "Accept cookies" covers button "Buy", so it was clicked through the DOM');
  assert.equal(await title(), 'clicks 1');
  results.push('covered: named, clicked in the DOM');

  refs = await open(page('Swallowed', `${count}<button onclick="hit()">Buy</button>
    <script>addEventListener('mousedown', (e) => e.stopImmediatePropagation(), true);
    addEventListener('click', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);</script>`));
  const byName = await service.clickByName('land', 'Buy', undefined);
  assert.equal(byName.note, 'the mouse click did not reach button "Buy", so it was clicked through the DOM');
  assert.equal(await title(), 'clicks 1');
  results.push('missed: clicked in the DOM');

  refs = await open(page('Disabled', `${count}<button onclick="hit()" disabled>Buy</button>`));
  await assert.rejects(service.clickByName('land', 'Buy', undefined), /button "Buy" is disabled; nothing was clicked\./);
  results.push('disabled: refused');

  refs = await open(page('Label', `${count}<label><input type="checkbox" onclick="hit()"
    style="position:absolute;opacity:0"><span style="display:inline-block;width:40px;height:40px;position:relative">Bacon</span></label>`));
  clicked = await service.click('land', ref(refs, 'checkbox "Bacon"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('label: its control counts');

  await open(page('Release', `<p>Assets</p><div style="height:3000px"></div>
    <include-fragment id="lazy">Loading</include-fragment><include-fragment hidden>Never</include-fragment>
    <script>new IntersectionObserver((seen, watcher) => { if (seen[0].isIntersecting) { watcher.disconnect();
      setTimeout(() => lazy.replaceWith(Object.assign(document.createElement('p'), { textContent: 'bun-linux-x64.zip 49.4 MB' })), 200); } }).observe(lazy);</script>`));
  assert.equal(await service.loadLazyParts('land', undefined), 0);
  assert.match(await service.text('land', undefined), /bun-linux-x64\.zip 49\.4 MB/);
  assert.equal(await service.evaluate('land', undefined, 'scrollY'), 0);
  results.push('lazy: loaded, scroll restored');

  await open(page('Stuck', `<div style="height:3000px"></div><include-fragment>Loading</include-fragment>`));
  assert.equal(await service.loadLazyParts('land', undefined), 1);
  results.push('stuck: reported');

  console.log(results.join('; '));
} finally {
  clearTimeout(deadline);
  cdp.close();
  browser.kill();
}
