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
const count = `<script>window.n = 0; function hit() { document.title = 'clicks ' + (++window.n); }</script>`;

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

  refs = await open(page('Behind', `${count}<button onclick="if (event.isTrusted) hit()">Buy</button>`));
  const front = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
  await cdp.send('Target.activateTarget', { targetId: front.targetId });
  assert.equal(await service.evaluate('land', undefined, 'document.visibilityState'), 'hidden');
  const behind = Date.now();
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.ok(Date.now() - behind < 1000, `a click in a background tab took ${Date.now() - behind} ms`);
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  await cdp.send('Target.closeTarget', { targetId: front.targetId });
  await cdp.send('Target.activateTarget', { targetId });
  results.push('background tab: one mouse click, no wait');

  refs = await open(page('Scrolled', `${count}<p style="height:2000px">Above</p><div>Price <button onclick="hit()">Buy</button></div>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('scrolled: one mouse click');

  refs = await open(page('Covered', `${count}<button onclick="hit()">Buy</button>
    <div id="veil" style="position:fixed;inset:0;background:#0001">Accept cookies</div>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, 'div#veil "Accept cookies" covers button "Buy", so only a click event was sent to it, without mouse-down');
  assert.equal(await title(), 'clicks 1');
  results.push('covered: named, clicked in the DOM');

  refs = await open(page('Swallowed', `${count}<button onclick="hit()">Buy</button>
    <script>addEventListener('click', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);
    addEventListener('mousedown', (e) => e.stopImmediatePropagation(), true);
    addEventListener('pointerdown', (e) => e.stopImmediatePropagation(), true);</script>`));
  const byName = await service.clickByName('land', 'Buy', undefined);
  assert.equal(byName.note, 'the click may not have reached button "Buy"; check the page');
  assert.equal(await title(), 'Swallowed');
  results.push('swallowed: reported, never repeated');

  refs = await open(page('Pressed', `${count}<button onclick="hit()">Buy</button>
    <script>addEventListener('click', (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);</script>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, 'the press reached button "Buy" but no click followed; check the page');
  assert.equal(await title(), 'Pressed');
  results.push('pressed only: reported, never repeated');

  refs = await open(page('Still', `${count}<button onclick="hit()">Buy</button>
    <script>addEventListener('mousemove', (e) => e.stopImmediatePropagation(), true);</script>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, 'the mouse is not reaching button "Buy" in this tab, so only a click event was sent to it, without mouse-down');
  assert.equal(await title(), 'clicks 1');
  results.push('no mouse: clicked in the DOM instead, once');

  refs = await open(page('Hover', `${count}<button onclick="hit()" onmouseenter="veil.hidden = false">Buy</button>
    <div id="veil" hidden style="position:fixed;inset:0">Menu</div>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, 'div#veil "Menu" covers button "Buy" once the mouse is over it, so only a click event was sent to it, without mouse-down');
  assert.equal(await title(), 'clicks 1');
  results.push('hover opens a cover: clicked in the DOM instead, once');

  await open(page('Busy', `<include-fragment src="/x">Loading</include-fragment>`));
  await service.evaluate('land', undefined, 'setTimeout(() => { const end = Date.now() + 2600; while (Date.now() < end); }, 50), 1');
  await Bun.sleep(100);
  assert.equal(await service.loadLazyParts('land', undefined), 0);
  await Bun.sleep(2600);
  results.push('busy page: lazy step gives way');

  refs = await open(page('Closed', `${count}<x-buy></x-buy><script>customElements.define('x-buy', class extends HTMLElement {
    constructor() { super(); const b = document.createElement('button'); b.textContent = 'Buy'; b.onclick = hit;
      this.attachShadow({ mode: 'closed' }).append(b); } });</script>`));
  clicked = await service.click('land', ref(refs, 'button "Buy"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('closed shadow: one mouse click');

  refs = await open(page('Frame', `${count}<p style="height:1500px">Above</p>
    <iframe srcdoc="<button onclick='parent.hit()'>Inner</button>"></iframe>`));
  for (let attempt = 0; attempt < 50 && !/button "Inner"/.test(refs); attempt++) { await Bun.sleep(50); refs = (await service.refs('land')).refs; }
  clicked = await service.click('land', ref(refs, 'button "Inner"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('same-site iframe: one mouse click');

  refs = await open(page('Disabled', `${count}<button onclick="hit()" disabled>Buy</button>`));
  await assert.rejects(service.clickByName('land', 'Buy', undefined), /button "Buy" is disabled; nothing was clicked\./);
  refs = await open(page('Fieldset', `${count}<fieldset disabled><button onclick="hit()">Buy</button></fieldset>`));
  await assert.rejects(service.clickByName('land', 'Buy', undefined), /button "Buy" is disabled; nothing was clicked\./);
  assert.equal(await title(), 'Fieldset');
  results.push('disabled and fieldset-disabled: refused');

  refs = await open(page('Label', `${count}<label><input type="checkbox" onclick="hit()"
    style="position:absolute;opacity:0"><span style="display:inline-block;width:40px;height:40px;position:relative">Bacon</span></label>`));
  clicked = await service.click('land', ref(refs, 'checkbox "Bacon"'));
  assert.equal(clicked.note, undefined);
  assert.equal(await title(), 'clicks 1');
  results.push('label: its control counts');

  await open(page('Release', `<p>Assets</p><div id="box" style="height:100px;overflow:auto"><div style="height:2000px"></div>
    <include-fragment id="lazy" src="/assets">Loading</include-fragment></div>
    <include-fragment src="/hidden" style="visibility:hidden">Never</include-fragment><include-fragment>No source</include-fragment>
    <script>new IntersectionObserver((seen, watcher) => { if (seen[0].isIntersecting) { watcher.disconnect();
      setTimeout(() => lazy.replaceWith(Object.assign(document.createElement('p'), { textContent: 'bun-linux-x64.zip 49.4 MB' })), 200); } }).observe(lazy);</script>`));
  assert.equal(await service.loadLazyParts('land', undefined), 0);
  assert.match(await service.text('land', undefined), /bun-linux-x64\.zip 49\.4 MB/);
  assert.deepEqual(await service.evaluate('land', undefined, '[scrollY, box.scrollTop]'), [0, 0]);
  results.push('lazy: loaded, scroll restored');

  await open(page('Idle', `<include-fragment src="/x" hidden>Never</include-fragment><include-fragment src="/y" style="opacity:0">Never</include-fragment>`));
  const started = Date.now();
  assert.equal(await service.loadLazyParts('land', undefined), 0);
  assert.ok(Date.now() - started < 1000, 'hidden fragments must not cost the 4 s wait');
  results.push('hidden: no wait');

  await open(page('Stuck', `<div style="height:3000px"></div><include-fragment src="/never">Loading</include-fragment>`));
  assert.equal(await service.loadLazyParts('land', undefined), 1);
  assert.equal(await service.evaluate('land', undefined, 'scrollY'), 0);
  results.push('stuck: reported, scroll restored');

  console.log(results.join('; '));
} finally {
  clearTimeout(deadline);
  cdp.close();
  browser.kill();
}
