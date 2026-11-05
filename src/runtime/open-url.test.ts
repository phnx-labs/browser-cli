import { afterEach, beforeEach, expect, test } from 'bun:test';
import { showUrl } from './open-url.js';

const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };

beforeEach(() => {
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.skipIf(process.platform !== 'linux')('the OS handler on a Linux box with no display reports nothing shown, not `open`', async () => {
  expect(await showUrl('https://example.com/', { osBrowser: true })).toEqual({
    via: 'none',
    reason: 'this machine has no display (DISPLAY and WAYLAND_DISPLAY are unset)',
  });
});

const opener = async (exit: string) => {
  const started = Date.now();
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/testdata/show-os.ts`], {
    env: { ...process.env, DISPLAY: ':99', PATH: `${import.meta.dir}/testdata/opener:${process.env.PATH}`, SHOW_OPENER_EXIT: exit },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, outcome: JSON.parse(out), ms: Date.now() - started };
};

test.skipIf(process.platform !== 'linux')('a handler that exits 0 is shown, and the browser it started does not keep show running', async () => {
  const { code, outcome, ms } = await opener('0');
  expect(outcome).toEqual({ via: 'open' });
  expect(code).toBe(0);
  expect(ms).toBeLessThan(5_000);
});

test.skipIf(process.platform !== 'linux')('a handler that exits non-zero is not shown, with its own words', async () => {
  const { outcome } = await opener('3');
  expect(outcome).toEqual({ via: 'none', reason: "xdg-open exited 3: xdg-open: no method available for opening 'https://example.com/'" });
});
