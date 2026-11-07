
export type Page = { url: string; title: string; text: string; description: string };
export type Grade = { correct: boolean; detail: string; error?: boolean };

const norm = (s: string) => s.toLowerCase().replace(/[ \s]+/g, ' ');

const truth = new Map<string, Promise<string>>();
function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  if (!truth.has(url)) {
    const p = fetch(url, { headers: { 'user-agent': 'browser-cli-bench grader', ...headers } }).then((res) => {
      if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
      return res.text();
    });
    p.catch(() => truth.delete(url));
    truth.set(url, p);
  }
  return truth.get(url)!;
}
const pastLastPage = (error: { status?: number }) => {
  if (error.status === 404) return '';
  throw error;
};
export function onSite(url: string, host: string, path = ''): boolean {
  try {
    const u = new URL(url);
    return (u.hostname === host || u.hostname.endsWith(`.${host}`)) && u.pathname.startsWith(path);
  } catch {
    return false;
  }
}

const html = (url: string) => fetchText(url).catch(pastLastPage);

export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(million|billion|[kmb])?\b/gi)) {
    let n = Number(m[1].replace(/,/g, ''));
    const unit = (m[2] ?? '').toLowerCase();
    if (unit === 'k') n *= 1e3;
    if (unit === 'm' || unit === 'million') n *= 1e6;
    if (unit === 'b' || unit === 'billion') n *= 1e9;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const near = (values: number[], target: number, tolerance: number) =>
  values.some((v) => Math.abs(v - target) <= Math.abs(target) * tolerance);

function titleMatches(answer: string, title: string): boolean {
  const words = norm(title).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2);
  const said = norm(answer);
  return words.length > 0 && words.filter((w) => said.includes(w)).length / words.length >= 0.6;
}

async function books(_: Page[], answer: string): Promise<Grade> {
  const base = 'https://books.toscrape.com/catalogue/category/books/mystery_3/';
  let best: { title: string; price: number } | undefined;
  for (let page = 1; ; page++) {
    const body = await html(page === 1 ? `${base}index.html` : `${base}page-${page}.html`);
    const pods = body.split('<article class="product_pod">').slice(1);
    if (pods.length === 0) break;
    for (const pod of pods) {
      if (!pod.includes('star-rating Five')) continue;
      const title = /title="([^"]+)"/.exec(pod)?.[1] ?? '';
      const price = Number(/£([\d.]+)/.exec(pod)?.[1]);
      if (!Number.isFinite(price)) throw new Error(`no price on "${title}"`);
      if (!best || price < best.price) best = { title: title.replace(/&#39;/g, "'").replace(/&amp;/g, '&'), price };
    }
  }
  if (!best) return { correct: false, detail: 'grader could not read the category', error: true };
  const ok = answer.includes(best.price.toFixed(2)) && titleMatches(answer, best.title);
  return { correct: ok, detail: `expected "${best.title}" at £${best.price.toFixed(2)}` };
}

async function pizza(pages: Page[]): Promise<Grade> {
  const page = pages.find((p) => onSite(p.url, 'httpbin.org', '/post'));
  if (!page) return { correct: false, detail: 'no open tab on httpbin.org/post' };
  let form: Record<string, unknown> = {};
  try {
    form = JSON.parse(page.text).form ?? {};
  } catch {
    return { correct: false, detail: 'the httpbin.org/post tab is not its JSON response' };
  }
  const toppings = ([] as unknown[]).concat(form.topping ?? []).map(String);
  const checks: [string, boolean][] = [
    ['custname', form.custname === 'Ada Lovelace'],
    ['custtel', form.custtel === '555-0100'],
    ['custemail', form.custemail === 'ada@example.com'],
    ['size', form.size === 'large'],
    ['toppings', toppings.includes('bacon') && toppings.includes('cheese') && toppings.length === 2],
    ['delivery', form.delivery === '19:45'],
    ['comments', norm(String(form.comments ?? '')) === 'ring twice'],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { correct: failed.length === 0, detail: failed.length ? `wrong fields: ${failed.join(', ')}` : 'all fields submitted' };
}

async function bun(_: Page[], answer: string): Promise<Grade> {
  const release = JSON.parse(
    await fetchText('https://api.github.com/repos/oven-sh/bun/releases/latest', { accept: 'application/vnd.github+json' }),
  ) as { tag_name: string; assets: { name: string; size: number }[] };
  const zip = release.assets.find((a) => a.name === 'bun-linux-x64.zip');
  const counts = [release.assets.length, release.assets.length + 2];
  const nums = numbersIn(answer);
  const tagOk = answer.includes(release.tag_name) || answer.includes(release.tag_name.replace(/^bun-v/, ''));
  const countOk = counts.some((c) => nums.includes(c));
  const mb = zip ? zip.size / 1e6 : NaN;
  const mib = zip ? zip.size / 2 ** 20 : NaN;
  const sizeOk = zip ? near(nums, mb, 0.02) || near(nums, mib, 0.02) || nums.includes(zip.size) : false;
  return {
    correct: tagOk && countOk && sizeOk,
    detail: `expected ${release.tag_name}, ${counts.join(' or ')} assets, ${mb.toFixed(1)} MB; tag ${tagOk}, count ${countOk}, size ${sizeOk}`,
  };
}

async function saucedemo(pages: Page[]): Promise<Grade> {
  const done = pages.find((p) => onSite(p.url, 'saucedemo.com', '/checkout-complete.html'));
  return { correct: Boolean(done), detail: done ? 'checkout-complete page open' : 'no open tab on checkout-complete.html' };
}

async function laptops(_: Page[], answer: string): Promise<Grade> {
  const base = 'https://webscraper.io/test-sites/e-commerce/static/computers/laptops';
  let best: { title: string; price: number } | undefined;
  for (let page = 1; page < 60; page++) {
    const body = await html(`${base}?page=${page}`);
    const cards = body.split('class="card thumbnail"').slice(1);
    if (cards.length === 0) break;
    for (const card of cards) {
      const price = Number(/\$([\d,.]+)/.exec(card)?.[1]?.replace(/,/g, ''));
      const title = /title="([^"]+)"/.exec(card)?.[1] ?? '';
      if (!Number.isFinite(price)) throw new Error(`no price on "${title}"`);
      if (!best || price > best.price) best = { title, price };
    }
  }
  if (!best) return { correct: false, detail: 'grader could not read the laptop pages', error: true };
  const ok = near(numbersIn(answer), best.price, 0.001);
  return { correct: ok, detail: `expected $${best.price.toFixed(2)} (${best.title})` };
}

async function demoblaze(pages: Page[], answer: string): Promise<Grade> {
  const page = pages.find((p) => onSite(p.url, 'demoblaze.com') && /Thank you for your purchase/i.test(p.text));
  const shown = page ? /Amount:\s*(\d+)/.exec(page.text)?.[1] : undefined;
  const said = numbersIn(answer).includes(1180);
  return { correct: shown === '1180' && said, detail: `confirmation open: ${Boolean(page)}, its Amount ${shown ?? 'none'}; answer gives 1180: ${said}` };
}

async function instagram(pages: Page[], answer: string): Promise<Grade> {
  const page = pages.find((p) => onSite(p.url, 'instagram.com', '/nasa'));
  if (!page) return { correct: false, detail: 'no open tab on instagram.com/nasa' };
  const shown = /([\d.,]+\s*[KMB]?)\s+Followers/i.exec(`${page.description} ${page.text}`)?.[1];
  if (!shown) return { correct: false, detail: 'the open tab shows no follower count (login wall?)', error: true };
  const target = numbersIn(shown)[0];
  const ok = /nasa/i.test(answer) && (answer.includes(shown.trim()) || near(numbersIn(answer), target, 0.01));
  return { correct: ok, detail: `page shows ${shown.trim()} followers` };
}

async function wikipedia(_: Page[], answer: string): Promise<Grade> {
  const api = 'https://en.wikipedia.org/w/api.php?action=parse&page=Buenos_Aires&prop=wikitext&section=0&format=json';
  const wikitext = String(JSON.parse(await fetchText(api)).parse?.wikitext?.['*'] ?? '');
  const figures = [...wikitext.matchAll(/population_(?:total|urban|metro|density_km2)?\w*\s*=\s*\{?\{?(?:[^|}\n]*\|)?\s*([\d,]{6,})/g)].map((m) =>
    Number(m[1].replace(/,/g, '')),
  );
  const said = norm(answer);
  const placeOk = said.includes('argentina') && said.includes('buenos aires');
  const popOk = figures.some((f) => near(numbersIn(answer), f, 0.01));
  return { correct: placeOk && popOk, detail: `infobox figures ${figures.join(', ')}; place ${placeOk}, population ${popOk}` };
}

const graders: Record<string, (pages: Page[], answer: string) => Promise<Grade>> = {
  books,
  pizza,
  bun,
  saucedemo,
  laptops,
  demoblaze,
  instagram,
  wikipedia,
};

export async function grade(task: string, pages: Page[], answer: string): Promise<Grade> {
  const grader = graders[task];
  if (!grader) throw new Error(`no grader for ${task}`);
  try {
    return await grader(pages, answer);
  } catch (error) {
    return { correct: false, detail: `grader error: ${(error as Error).message}`, error: true };
  }
}

const PAGE_EXPRESSION = `JSON.stringify({url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 50000) : '', description: (document.querySelector('meta[name=description]') || document.querySelector('meta[property="og:description"]') || {content: ''}).content || ''})`;

export async function openPages(port: number): Promise<Page[]> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];
  const pages: Page[] = [];
  for (const t of targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)) {
    const expression = PAGE_EXPRESSION;
    const value = await new Promise<string | undefined>((resolve) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl!);
      const timer = setTimeout(() => (ws.close(), resolve(undefined)), 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result?.value);
      };
      ws.onerror = () => (clearTimeout(timer), resolve(undefined));
    });
    if (value) pages.push(JSON.parse(value));
    else pages.push({ url: t.url, title: '', text: '', description: '' });
  }
  return pages;
}
