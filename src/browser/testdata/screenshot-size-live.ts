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
  const task = { id: 'shot', name: 'shot', profile: 'shot@endpoint-0', tabs: { a: targetId },
    currentTabId: 'a', createdAt: Date.now(), lastActionAt: Date.now(), pid: browser.pid };
  const service = new BrowserService();
  (service as any).connections.set('shot@endpoint-0', { cdp, backend: 'cdp', browserType: 'chrome', key: 'shot@endpoint-0',
    profile: 'shot', pid: browser.pid, tasks: new Map([['shot', task]]), sessionCache: new Map() });
  await service.navigate('shot', `data:text/html,${encodeURIComponent('<!doctype html><title>tall</title><body style="margin:0"><div style="height:1000px;background:red"></div><div style="height:2000px;background:blue"></div>')}`);
  const centre = async (file: string) => String(await service.evaluate('shot', undefined, `new Promise((done) => {
    const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const [r, , b] = context.getImageData(image.width / 2, image.height / 2, 1, 1).data;
      done(b > r ? 'blue' : 'red'); }; image.src = 'data:image/jpeg;base64,${(await readFile(file)).toString('base64')}'; })`));
  const seen: string[] = [];
  for (const ratio of [2, 1.5]) {
    await service.setViewport('shot', 800, 600, { deviceScaleFactor: ratio });
    await service.evaluate('shot', undefined, 'window.scrollTo(0, 1000)');
    const compressed = await service.screenshot('shot', undefined, join(directory, `c${ratio}.jpg`));
    const raw = await service.screenshot('shot', undefined, join(directory, `r${ratio}.png`), 'raw');
    seen.push(`${ratio}x: compressed ${compressed.width}x${compressed.height} ${await centre(compressed.path)}, raw ${raw.width}x${raw.height}`);
  }
  console.log(seen.join('; '));
} finally {
  clearTimeout(deadline);
  cdp.close();
  browser.kill();
}
