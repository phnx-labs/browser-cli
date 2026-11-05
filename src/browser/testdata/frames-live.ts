// Drives a real Chromium through BrowserService to prove an agent can work
// inside iframes: `refs` lists a same-site and a cross-site frame's elements,
// `type`, `select` and `click` reach into both, and `text` reads both. A
// click on a button below the fold scrolls to it instead of hitting nothing.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserService } from '../service.js';
import { CDPClient } from '../cdp.js';

const directory = process.env.AGENTS_HOME!;
const INNER = `<!doctype html><h2>Inner quiz</h2><p id="q">What is 7 x 8?</p>
<label>Answer <input id="ans"></label>
<label>Range <select id="range"><option>0-10</option><option value="hard">11-12</option></select></label>
<button onmouseover="hv.textContent='hovered'" onclick="q.textContent='Answered: '+ans.value+' in '+range.value">Inner Go</button>
<input type="file" id="pick" aria-label="Attachment"><span id="hv"></span>`;
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    const html: string = pathname === '/inner'
      ? INNER
      : `<!doctype html><title>Host</title><h1>Host page</h1><button>Outer</button>
         <iframe src="/inner" width="500" height="200"></iframe>
         <iframe src="http://127.0.0.1:${server.port}/inner" width="500" height="200"></iframe>
         <div style="height:4000px"></div><button onclick="document.title='Far clicked'">Far</button>`;
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  },
});
const browser = Bun.spawn([
  process.argv[2]!, '--headless', '--remote-debugging-port=0',
  `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
const cdp = new CDPClient();
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 20_000);

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
  // localhost and 127.0.0.1 are different sites, so the second frame is its own process.
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://localhost:${server.port}/` }) as { targetId: string };
  const key = 'frames@endpoint-0';
  const task = { id: 'frames', name: 'frames', profile: key, tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key,
    profile: 'frames', pid: browser.pid, tasks: new Map([['frames', task]]), sessionCache: new Map() });

  let listing = '';
  for (let attempt = 0; attempt < 100 && (listing.match(/Inner Go/g) ?? []).length < 2; attempt++) {
    listing = (await service.refs('frames')).refs;
    await Bun.sleep(50);
  }
  const blocks = listing.split(/^- iframe /m);
  assert.equal(blocks.length, 3, `two iframe blocks expected:\n${listing}`);
  assert.match(blocks[0]!, /button "Outer" \[ref=1\]/);
  const refIn = (block: string, pattern: RegExp) => Number(pattern.exec(block)![1]);

  // Hover reaches the cross-site frame with the numbering `refs` printed.
  await service.hover('frames', refIn(blocks[2]!, /button "Inner Go" \[ref=(\d+)\]/));
  // Upload refuses a cross-site frame instead of clicking the wrong spot.
  await assert.rejects(
    service.upload('frames', [import.meta.path], { ref: refIn(blocks[2]!, /button "Attachment" \[ref=(\d+)\]/) }),
    /inside a cross-site iframe/,
  );

  for (const [block, answer] of [[blocks[1]!, '56'], [blocks[2]!, '42']] as const) {
    await service.type('frames', refIn(block, /textbox "Answer\s*" \[ref=(\d+)\]/), answer);
    assert.equal((await service.select('frames', refIn(block, /combobox "Range\s*" \[ref=(\d+)\]/), '11-12')).selected, '11-12');
    await service.click('frames', refIn(block, /button "Inner Go" \[ref=(\d+)\]/));
  }

  let text = '';
  for (let attempt = 0; attempt < 100 && !text.includes('Answered: 42'); attempt++) {
    text = await service.text('frames', undefined);
    await Bun.sleep(25);
  }
  assert.match(text, /^Host — http:\/\/localhost:\d+\/\n/);
  assert.match(text, /--- iframe http:\/\/localhost:\d+\/inner ---\nInner quiz[\s\S]*Answered: 56 in hard/);
  assert.match(text, /--- iframe http:\/\/127\.0\.0\.1:\d+\/inner ---\nInner quiz[\s\S]*Answered: 42 in hard[\s\S]*hovered/);
  await assert.rejects(service.select('frames', 1, 'x'), /not a <select>/);

  await service.click('frames', refIn(blocks[0]!, /button "Far" \[ref=(\d+)\]/));
  for (let attempt = 0; attempt < 100 && !text.startsWith('Far clicked'); attempt++) {
    text = await service.text('frames', undefined);
    await Bun.sleep(25);
  }
  assert.match(text, /^Far clicked — /);

  console.log('refs: both frames listed; type, select, click: reached both; text: read both; below the fold: clicked');
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
  server.stop(true);
}
