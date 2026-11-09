// `start` returns on the page it opened, and a second unnamed `start` from the
// same agent session goes on in that session's task. In the benchmark,
// `start --url … && browser text` read about:blank, and an agent that started
// again to go back to a page got a second task and an ambiguous next verb.
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
// A page that answers 400 ms late, so a start that returns as the tab opens reads about:blank.
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    await Bun.sleep(400);
    const title = new URL(request.url).pathname.slice(1);
    // `late` draws its button 600 ms after it loads, as a shop's product list does.
    if (title === 'list') {
      return new Response(`<!doctype html><title>list</title><ul><li><a href="/a">Alpha</a> $1</li><li><a href="/b">Beta</a> $2</li></ul>`, { headers: { 'content-type': 'text/html' } });
    }
    if (title === 'form') {
      return new Response(`<!doctype html><title>form</title><label>Email <input id="e"></label><button>Email us</button>
        <select aria-label="Sort"><option>Name</option><option>Price (low to high)</option></select>
        <label>Sort note <input id="n" role="combobox"></label><label>Delivery <input id="d" type="time"></label>`, { headers: { 'content-type': 'text/html' } });
    }
    const late = title === 'late'
      ? `<script>setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Late button'; b.onclick = () => { document.body.append('late clicked'); }; document.body.append(b); }, 600)</script>`
      : '';
    return new Response(`<!doctype html><title>${title}</title><p>${title} page</p><p>Population&nbsp;(2022 census)</p>${late}`, { headers: { 'content-type': 'text/html' } });
  },
});
const page = (title: string) => `http://127.0.0.1:${server.port}/${title}`;

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
  await createProfile({ name: 'reuse', browser: 'custom', binary: process.argv[2]!, endpoints: [address], launchPolicy: 'attach-only' });

  const service = new BrowserService();
  const first = await service.start('reuse', { url: page('home'), sessionId: 'agent-a' });
  const home = await service.text(first.task, undefined);
  assert.ok(home.includes('home page'), `start returns on the loaded page, got: ${home.slice(0, 120)}`);
  assert.ok(home.includes('Population (2022 census)'), 'text prints a no-break space as a space, so grep matches it');

  const again = await service.start('reuse', { url: page('cart'), sessionId: 'agent-a' });
  assert.equal(again.task, first.task, 'the same session keeps its one task');
  const cart = await service.text(first.task, undefined);
  assert.ok(cart.includes('cart page'), `the second start navigated that task, got: ${cart.slice(0, 120)}`);

  const other = await service.start('reuse', { url: page('other'), sessionId: 'agent-b' });
  assert.notEqual(other.task, first.task, 'another session gets its own task');
  const named = await service.start('reuse', { url: page('named'), sessionId: 'agent-a', taskName: 'second' });
  assert.notEqual(named.task, first.task, 'a named start still opens a second task');

  // Two unnamed starts from one new session at once still make one task.
  const pair = await Promise.all([page('left'), page('right')].map((url) => service.start('reuse', { url, sessionId: 'agent-c' })));
  assert.equal(pair[0].task, pair[1].task, 'concurrent starts from one session share a task');
  const blank = Date.now();
  const empty = await service.start('reuse', { url: 'about:blank', sessionId: 'agent-d' });
  assert.ok(Date.now() - blank < 2_000, 'a blank start does not wait out the load timeout');

  const drawn = await service.start('reuse', { url: page('late'), sessionId: 'agent-e' });
  await service.clickByName(drawn.task, 'Late button', undefined);
  const after = await service.text(drawn.task, undefined);
  assert.ok(after.includes('late clicked'), `click --text waits for an element drawn after load, got: ${after.slice(0, 120)}`);

  // type and select name the element instead of a ref; "Email" types into the field, not the button.
  const form = await service.start('reuse', { url: page('form'), sessionId: 'agent-f' });
  await service.type(form.task, 'Email', 'ada@example.com');
  await service.select(form.task, 'Sort', 'Price (low to high)');
  // "Sort" names the <select> exactly, but typing goes to the text combobox "Sort note"; a time input takes its value by name.
  await service.type(form.task, 'Sort', 'cheapest');
  await service.type(form.task, 'Delivery', '19:45');
  const values = await service.evaluate(form.task, undefined, "['e', 'n', 'd'].map((id) => document.getElementById(id).value).join('|') + '|' + document.querySelector('select').value");
  assert.equal(values, 'ada@example.com|cheapest|19:45|Price (low to high)', 'type and select by name reach the fields and the select');
  await assert.rejects(service.type(form.task, '  ', 'x'), /Name the element/, 'an empty name picks nothing');

  // Two scripts that each declare the same top-level const run one after the other, as in the console.
  assert.equal(await service.evaluate(form.task, undefined, "const sel = 'select'; document.querySelectorAll(sel).length"), 1);
  assert.equal(await service.evaluate(form.task, undefined, "const sel = 'input'; document.querySelectorAll(sel).length"), 3);

  // An async script still answers with what it resolves to, and a rejection is an error.
  assert.equal(await service.evaluate(form.task, undefined, '(async () => { await 0; return 9 })()'), 9);
  assert.equal(await service.evaluate(form.task, undefined, 'new Promise((r) => setTimeout(() => r(4), 100))'), 4);
  assert.deepEqual(await service.evaluate(form.task, undefined, '({a: [1, 2]})'), { a: [1, 2] });
  await assert.rejects(service.evaluate(form.task, undefined, '(async () => { throw new Error("async boom") })()'), /async boom/);
  await assert.rejects(service.evaluate(form.task, undefined, 'throw new Error("sync boom")'), /sync boom/);

  // text --css lists each match's text, or an attribute, without a script.
  const list = await service.start('reuse', { url: page('list'), sessionId: 'agent-g' });
  const items = await service.text(list.task, undefined, { css: 'li' });
  assert.ok(items.endsWith('Alpha $1\n--\nBeta $2'), `one block per match, got: ${items}`);
  const links = await service.text(list.task, undefined, { css: 'li a', attr: 'href' });
  assert.ok(links.endsWith(`${page('a')}\n--\n${page('b')}`), `href comes back absolute, got: ${links}`);
  await assert.rejects(service.text(list.task, undefined, { css: 'table' }), /No element matches "table"/);
  await assert.rejects(service.text(list.task, undefined, { css: 'li[' }), /Invalid CSS selector "li\["/);

  const refused = 'http://127.0.0.1:1/';
  const failed = /Could not open http:\/\/127\.0\.0\.1:1\/: net::ERR_CONNECTION_REFUSED\./;
  await assert.rejects(service.navigate(list.task, refused, undefined, { wait: true }), failed, 'navigate reports the net error');
  await assert.rejects(service.navigate(list.task, refused), failed, 'navigate --no-wait reports it too');
  await assert.rejects(service.start('reuse', { url: refused, sessionId: 'agent-h' }), failed, 'start --url reports it');
  const failedStart = await service.start('reuse', { sessionId: 'agent-h' });

  for (const s of [first, other, named, pair[0], empty, drawn, form, list, failedStart]) await service.done(s.task);
  console.log('start settles; a second start goes on in the session task');
} finally {
  clearTimeout(deadline);
  server.stop(true);
  browser.kill();
}
process.exit(0);
