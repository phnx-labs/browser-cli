import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchBrowser } from './chrome.js';

const EXITS = path.join(import.meta.dir, 'testdata', 'launch-exit', 'exits-with-stderr');

describe('launchBrowser when the browser exits during launch', () => {
  let runtimeDir: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.AGENTS_HOME;
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-launch-exit-'));
    process.env.AGENTS_HOME = runtimeDir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = saved;
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('names the browser’s own stderr on the pipe transport', async () => {
    const launch = launchBrowser('exit-pipe', 'chromium', 0, { headless: true }, undefined, EXITS);
    await expect(launch).rejects.toThrow(
      /^Chromium exited during launch \(code 1\): \[1:1:ERROR:zygote_host_impl_linux\.cc\(130\)\] No usable sandbox! try using --no-sandbox\.\n {2}fixture line 2\n {2}fixture line 3\n {2}fixture line 4\n {2}fixture line 5$/,
    );
  });

  it('names the browser’s own stderr on the port transport', async () => {
    const store = path.join(runtimeDir, 'owner-store');
    fs.mkdirSync(store);
    const launch = launchBrowser('exit-port', 'chromium', 9, { headless: true, userDataDir: store }, undefined, EXITS);
    await expect(launch).rejects.toThrow('No usable sandbox! try using --no-sandbox.');
  });
});
