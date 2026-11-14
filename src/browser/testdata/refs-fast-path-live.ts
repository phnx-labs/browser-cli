// Drives a real Chromium through BrowserService to prove the ref fast paths: a
// click on a still-current ref never rebuilds the accessibility tree, a replaced
// node falls back to rebuild-and-heal, and `--snapshot` numbers refs as `refs` would.
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
const calls: string[] = [];
const send = cdp.send.bind(cdp);
cdp.send = ((method: string, params?: Record<string, unknown>, sessionId?: string) => {
  calls.push(method);
  return send(method, params, sessionId);
}) as typeof cdp.send;
const count = (method: string) => calls.filter((m) => m === method).length;
const deadline = setTimeout(() => { browser.kill(); process.exit(2); }, 20_000);

const page = (title: string, body: string) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title>${body}`)}`;
const FORM = page('Form', `
  <input id="a" aria-label="Alpha"><input id="b" aria-label="Beta"><input id="c" aria-label="Gamma">
  <button id="go" onclick="document.title='Clicked '+(++window.n||(window.n=1))">Go</button>
  <a href="#x">Elsewhere</a>`);
const EDITOR = page('Editor', `<div class="ProseMirror" contenteditable="true" aria-label="Body" role="textbox"></div>`);
const NEXT = page('Second', `<button>Only</button>`);

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
  const { targetId } = await cdp.send('Target.createTarget', { url: FORM }) as { targetId: string };
  const key = 'fast@endpoint-0';
  const task = { id: 'fast', name: 'fast', profile: key, tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set(key, { cdp, backend: 'cdp', browserType: 'chrome', key,
    profile: 'fast', pid: browser.pid, tasks: new Map([['fast', task]]), sessionCache: new Map() });
  const settled = async (expression: string, want: unknown) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      const value = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId) as { result: { value: unknown } };
      if (value.result.value === want) return;
      await Bun.sleep(25);
    }
    assert.fail(`page never reached ${expression} === ${String(want)}`);
  };
  await settled('document.readyState', 'complete');

  // Editor gate: three textboxes and no editor root cost one page question and
  // zero per-node walks; a real editor root is still detected.
  calls.length = 0;
  const listing = await service.refs('fast');
  assert.equal(count('Accessibility.getFullAXTree'), 1);
  assert.equal(count('Runtime.evaluate'), 1);
  assert.equal(count('DOM.resolveNode'), 0);
  assert.match(listing.refs, /textbox "Alpha" \[ref=\d+\]/);
  const goRef = Number(/button "Go" \[ref=(\d+)\]/.exec(listing.refs)![1]);

  // Click on a still-current ref: one partial-tree check, no full rebuild.
  calls.length = 0;
  await service.click('fast', goRef);
  assert.equal(count('Accessibility.getPartialAXTree'), 1);
  assert.equal(count('Accessibility.getFullAXTree'), 0);
  await settled('document.title', 'Clicked 1');

  // The node the ref pointed at is replaced by an equivalent one: the fast path
  // declines and the rebuild heals the ref onto the new node.
  {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await send('Runtime.evaluate', { expression: `document.getElementById('go').outerHTML = document.getElementById('go').outerHTML` }, sessionId);
  }
  calls.length = 0;
  await service.click('fast', goRef);
  assert.equal(count('Accessibility.getFullAXTree'), 1);
  await settled('document.title', 'Clicked 2');

  // Snapshot after navigate describes the destination, numbered like `refs`.
  const navigated = await service.navigate('fast', NEXT, undefined, { snapshot: true });
  assert.ok(navigated.snapshot, 'navigate --snapshot must return a snapshot');
  assert.equal(navigated.snapshot!.title, 'Second');
  assert.equal(navigated.snapshot!.url, NEXT);
  assert.equal(navigated.snapshot!.refs, (await service.refs('fast')).refs);
  assert.match(navigated.snapshot!.refs, /button "Only" \[ref=1\]/);
  const shot = await readFile(navigated.snapshot!.screenshot!);
  assert.match(navigated.snapshot!.screenshot!, /sessions\/fast\/[^/]+\.jpg$/);
  assert.deepEqual([...shot.subarray(0, 3)], [0xff, 0xd8, 0xff], 'snapshot screenshot must be a JPEG');
  assert.ok(shot.length < 100 * 1024, `snapshot screenshot is ${shot.length} bytes, over the 100 KB cap`);

  // A page with an editor root still gets its editor detected.
  await service.navigate('fast', EDITOR);
  await settled('document.title', 'Editor');
  const editorListing = await service.refs('fast');
  assert.match(editorListing.refs, /textbox "Body" \[ref=\d+\] \[editor=prosemirror\]/);

  // Enter submits a form: the key event must carry text for Chromium's
  // implicit submission, and the snapshot after it describes the result.
  const SUBMIT = page('Form', `<form onsubmit="document.title='submitted:'+q.value;return false"><input id="q" name="q" aria-label="Query"></form>`);
  await service.navigate('fast', SUBMIT);
  await settled('document.title', 'Form');
  const formListing = await service.refs('fast');
  const queryRef = Number(/textbox "Query" \[ref=(\d+)\]/.exec(formListing.refs)![1]);
  await service.type('fast', queryRef, 'abc');
  const entered = await service.press('fast', 'Enter', undefined, { snapshot: true });
  assert.equal(entered.snapshot!.title, 'submitted:abc');

  // A router link (pushState, no load event) clicked with --snapshot settles
  // on the in-page navigation instead of waiting out the 3 s load timeout, and
  // lists the page the router renders after the URL changes, not the old one.
  const html = { headers: { 'content-type': 'text/html' } };
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      // A slow next page: `--wait` must return after it loads, not when the click lands.
      if (new URL(req.url).pathname === '/slow') {
        await new Promise((r) => setTimeout(r, 400));
        return new Response('<!doctype html><title>Slow</title><p>Arrived</p>', html);
      }
      return new Response(`<!doctype html><title>Shop</title><a href="#app">Skip</a><a href="/slow">Onward</a><div id="app"><a id="cart" href="/cart">Cart</a></div><script>
      cart.onclick = (e) => { e.preventDefault(); history.pushState({}, '', '/cart'); setTimeout(() => { document.title = 'Cart'; app.innerHTML = '<button>Checkout</button>'; }, 300); };
    </script>`, html);
    },
  });
  const titleNow = async () => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    const { result } = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId) as { result: { value: string } };
    return result.value;
  };
  try {
    await service.navigate('fast', `http://127.0.0.1:${server.port}/`);
    await settled('document.title', 'Shop');
    const shop = await service.refs('fast');
    // An #anchor jump is in-page too, but no router renders after it.
    const skipRef = Number(/link "Skip" \[ref=(\d+)\]/.exec(shop.refs)![1]);
    const jumpStarted = performance.now();
    await service.click('fast', skipRef, undefined, { snapshot: true });
    const jumped = performance.now() - jumpStarted;
    assert.ok(jumped < 450, `#anchor click --snapshot took ${Math.round(jumped)} ms`);
    const cartRef = Number(/link "Cart" \[ref=(\d+)\]/.exec(shop.refs)![1]);
    const started = performance.now();
    const routed = await service.click('fast', cartRef, undefined, { snapshot: true });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_500, `same-document click --snapshot took ${Math.round(elapsed)} ms`);
    assert.equal(routed.snapshot!.url, `http://127.0.0.1:${server.port}/cart`);
    assert.match(routed.snapshot!.refs, /button "Checkout" \[ref=3\]/);

    // --wait: the same settles without the listing, so a chained next command
    // reads the page the action led to. navigate --wait returns once loaded.
    const base = `http://127.0.0.1:${server.port}`;
    const landed = await service.navigate('fast', `${base}/slow`, undefined, { wait: true });
    assert.equal(landed.snapshot, undefined);
    assert.equal(await titleNow(), 'Slow');
    // The same URL again reloads the tab; --wait returns after the reload, not
    // on the old document, which still reads as complete when the reload is sent.
    {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      await send('Runtime.evaluate', { expression: `document.title = 'Stale'` }, sessionId);
    }
    const reloaded = await service.navigate('fast', `${base}/slow`, undefined, { wait: true });
    assert.equal(reloaded.refreshed, true);
    assert.equal(await titleNow(), 'Slow');
    await service.navigate('fast', `${base}/`, undefined, { wait: true });
    assert.equal(await titleNow(), 'Shop');
    const onward = Number(/link "Onward" \[ref=(\d+)\]/.exec((await service.refs('fast')).refs)![1]);
    const clicked = await service.click('fast', onward, undefined, { wait: true });
    assert.equal(clicked.snapshot, undefined);
    assert.equal(await titleNow(), 'Slow');
    await service.navigate('fast', `${base}/`, undefined, { wait: true });
    await service.clickByName('fast', 'Cart', 'link', undefined, { wait: true });
    assert.equal(await titleNow(), 'Cart');
  } finally {
    server.stop(true);
  }

  // A button whose label changes in place ("Cart, 1 items" -> "Cart, 2 items")
  // is still the element its ref named: the click lands and says it was relabeled.
  const CART = page('Cart', `
    <button id="add" onclick="n.textContent = ++window.items; cart.setAttribute('aria-label', 'Cart, ' + window.items + ' items')">Add</button>
    <button id="cart" aria-label="Cart, 1 items" onclick="document.title = 'Opened ' + this.getAttribute('aria-label')">Cart</button>
    <span id="n"></span><script>window.items = 1</script>`);
  await service.navigate('fast', CART);
  await settled('document.title', 'Cart');
  const cartListing = await service.refs('fast');
  const addRef = Number(/button "Add" \[ref=(\d+)\]/.exec(cartListing.refs)![1]);
  const cartButton = Number(/button "Cart, 1 items" \[ref=(\d+)\]/.exec(cartListing.refs)![1]);
  await service.click('fast', addRef);
  await settled(`document.getElementById('cart').getAttribute('aria-label')`, 'Cart, 2 items');
  const relabeled = await service.click('fast', cartButton);
  assert.equal(relabeled.healed?.renamed, 'Cart, 2 items');
  await settled('document.title', 'Opened Cart, 2 items');

  // click --text: by accessible name, no listing first; a miss names what is there.
  const byName = await service.clickByName('fast', 'add', 'button');
  assert.equal(byName.clicked, 'button "Add"');
  await settled(`document.getElementById('cart').getAttribute('aria-label')`, 'Cart, 3 items');
  await assert.rejects(service.clickByName('fast', 'Checkout', undefined), /No element named "Checkout" on this page\. Elements here: button "Add", button "Cart, 3 items"/);

  // An alert() is accepted at once and reported; a confirm() waits for the
  // caller: the click returns with the question instead of hanging.
  const ALERT = page('Shop', `<button onclick="alert('Product added.'); document.title = confirm('Leave?') ? 'Confirmed' : 'Kept'">Add to cart</button>`);
  await service.navigate('fast', ALERT);
  await settled('document.title', 'Shop');
  const shopRefs = await service.refs('fast');
  const addToCart = Number(/button "Add to cart" \[ref=(\d+)\]/.exec(shopRefs.refs)![1]);
  const alertStarted = performance.now();
  const asked = await service.click('fast', addToCart);
  assert.ok(performance.now() - alertStarted < 3_000, 'a click that opens dialogs must not hang');
  assert.equal(asked.asking, 'confirm "Leave?"');
  assert.deepEqual(service.takeDialogs('fast'), ['alert "Product added."']);
  assert.equal(service.openDialog('fast'), 'confirm "Leave?"');
  assert.equal(await service.answerDialog('fast', false), 'confirm "Leave?"');
  await settled('document.title', 'Kept');
  assert.equal(service.openDialog('fast'), undefined);
  // Answering when nothing is open (the alert already went) is a no-op.
  assert.equal(await service.answerDialog('fast', true), undefined);
  await assert.rejects(service.answerDialog('no-such-task', true));

  // A recycled node whose label now names something else is not the element
  // the listing named: the click refuses instead of acting on it.
  const ROWS = page('Rows', `<button id="row" onclick="document.title = 'Deleted ' + this.textContent.slice(7)">Delete Alice</button>`);
  await service.navigate('fast', ROWS);
  await settled('document.title', 'Rows');
  const rows = await service.refs('fast');
  const rowRef = Number(/button "Delete Alice" \[ref=(\d+)\]/.exec(rows.refs)![1]);
  {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await send('Runtime.evaluate', { expression: `document.getElementById('row').textContent = 'Delete Bob'` }, sessionId);
  }
  await assert.rejects(service.click('fast', rowRef), /could not be re-resolved/);
  await settled('document.title', 'Rows');

  // Clicking an option of a closed native <select> chooses it.
  const PICK = page('Pick', `<select id="s" aria-label="Size" onchange="document.title = 'Picked ' + this.value"><option>Small</option><option>Large</option></select>`);
  await service.navigate('fast', PICK);
  await settled('document.title', 'Pick');
  const pick = await service.refs('fast');
  const largeRef = Number(/option "Large" \[ref=(\d+)\]/.exec(pick.refs)![1]);
  assert.equal((await service.click('fast', largeRef)).chose, 'Large');
  await settled('document.title', 'Picked Large');

  // Date and time inputs ignore inserted text: `type` sets the whole value,
  // reports what the input reads, and refuses a value the input rejects.
  const WHEN = page('When', `<label>Delivery <input type="time" id="t"></label><label>Day <input type="date" id="d"></label>`);
  await service.navigate('fast', WHEN);
  await settled('document.title', 'When');
  const when = await service.refs('fast');
  const timeRef = Number(/inputtime "Delivery ?" \[ref=(\d+)\]/.exec(when.refs)![1]);
  const dateRef = Number(/date "Day ?" \[ref=(\d+)\]/.exec(when.refs)![1]);
  const hoursRef = Number(/spinbutton "Hours[^"]*" \[ref=(\d+)\]/.exec(when.refs)![1]);
  assert.equal((await service.type('fast', timeRef, '7:45 PM')).reads, '19:45');
  assert.equal((await service.type('fast', dateRef, '2026-10-18')).reads, '2026-10-18');
  await assert.rejects(service.type('fast', dateRef, 'next tuesday-ish'), /The date input did not accept "next tuesday-ish"\. It takes YYYY-MM-DD/);
  // One field of the split input takes keystrokes; PM from before stays.
  assert.equal((await service.type('fast', hoursRef, '08')).reads, '20:45');

  // `browser wait` reads the page through evaluate, the one path every backend has.
  await service.wait('fast', 'selector', '#t');
  await service.wait('fast', 'url', 'data:*');
  await service.wait('fast', 'load', 'load');
  await service.wait('fast', 'function', "document.title === 'When'");
  await assert.rejects(service.wait('fast', 'selector', '#absent', { timeout: 300 }), /not met within 300ms\nNext: browser snapshot/);

  console.log('gate: one question, zero walks; click: partial check only; replaced node: healed; snapshot: destination + screenshot; editor: detected; enter: submitted; router click: settled; wait: settled; relabeled: same element');
} finally {
  clearTimeout(deadline);
  await cdp.close();
  browser.kill();
  await browser.exited;
}
