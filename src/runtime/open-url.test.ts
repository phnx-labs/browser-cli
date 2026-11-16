import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { describeShown, showUrl, type ShowOutcome } from './open-url.js';

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
    visible: false,
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
  expect(outcome).toEqual({
    via: 'open', visible: false, frontmost: 'unknown', notification: 'none',
    unknownWhy: 'only macOS reports the app in front, and this is linux',
  });
  expect(code).toBe(0);
  expect(ms).toBeLessThan(5_000);
});

test.skipIf(process.platform !== 'linux')('a handler that exits non-zero is not shown, with its own words', async () => {
  const { outcome } = await opener('3');
  expect(outcome).toEqual({ via: 'none', reason: "xdg-open exited 3: xdg-open: no method available for opening 'https://example.com/'", visible: false });
});

describe('describeShown', () => {
  const url = 'https://example.com/report';
  type Shown = Exclude<ShowOutcome, { via: 'none' }> & { device?: string };
  const arc = (seen: Partial<Shown>): Shown => ({
    via: 'profile', profile: 'arc-work', reused: false, app: 'Arc', device: 'zion',
    visible: false, frontmost: 'VSCodium', notification: 'clickable', ...seen,
  } as Shown);

  test('the incident: Arc behind VSCodium says so, and that a notification went out', () => {
    expect(describeShown(arc({}), url)).toBe('Opened in Arc (arc-work) on zion (behind VSCodium); notification sent: https://example.com/report');
  });

  test('in front only when visible', () => {
    expect(describeShown(arc({ visible: true, frontmost: 'Arc', notification: 'none' }), url))
      .toBe('Opened in Arc (arc-work) on zion, selected in its front window with Arc in front: https://example.com/report');
    expect(describeShown(arc({ reused: true, visible: true, frontmost: 'Arc', notification: 'none' }), url))
      .toBe('Reloaded the tab already showing it in Arc (arc-work) on zion, selected in its front window with Arc in front: https://example.com/report');
  });

  test('Arc in front with the page in another of its windows is not in front of the user', () => {
    expect(describeShown(arc({ frontmost: 'Arc' }), url))
      .toBe('Opened in Arc (arc-work) on zion (Arc is in front, but another of its windows or tabs is showing); notification sent: https://example.com/report');
  });

  test('a tab in a Space that is not showing names the Space; Spaces are never switched', () => {
    const hidden = { hiddenSpace: 'Work', hiddenWhy: 'the tab is in Arc Space Work, which is not the one showing' };
    expect(describeShown(arc(hidden), url))
      .toBe('Opened in Arc (arc-work) on zion, Space Work (not the one showing), behind VSCodium; notification sent: https://example.com/report');
    expect(describeShown(arc({ ...hidden, frontmost: 'Arc' }), url))
      .toBe('Opened in Arc (arc-work) on zion, Space Work (not the one showing), with Arc in front; notification sent: https://example.com/report');
  });

  test('the OS handler in front does not read as the page in front', () => {
    expect(describeShown({
      via: 'open', app: 'Safari', visible: false, frontmost: 'Safari', notification: 'clickable',
      unknownWhy: 'the OS default handler opened it and cannot be asked which tab or window is showing',
    }, url)).toBe('Opened in Safari; Safari is in front, but cannot tell whether it shows the page (the OS default handler opened it and cannot be asked which tab or window is showing); notification sent: https://example.com/report');
  });

  test('a notification that cannot open the page, or none at all, is said', () => {
    expect(describeShown(arc({ notification: 'plain' }), url)).toBe(
      'Opened in Arc (arc-work) on zion (behind VSCodium); notification sent, but clicking it does not open the page (install terminal-notifier for that): https://example.com/report');
    expect(describeShown(arc({ notification: 'none' }), url))
      .toBe('Opened in Arc (arc-work) on zion (behind VSCodium); no notification could be sent: https://example.com/report');
  });

  test('unknown is never reported as open in front: off macOS, and from a hub too old to say', () => {
    expect(describeShown({
      via: 'profile', profile: 'work', reused: false, visible: false, frontmost: 'unknown', notification: 'none',
      unknownWhy: 'only macOS reports the app in front, and this is linux',
    }, url)).toBe('Opened in work; cannot tell whether the user can see it (only macOS reports the app in front, and this is linux): https://example.com/report');
    expect(describeShown(arc({ app: undefined, frontmost: 'unknown', notification: 'none', unknownWhy: 'zion runs an older browser-cli that does not report it; update browser-cli there' }), url))
      .toBe('Opened in arc-work on zion; cannot tell whether the user can see it (zion runs an older browser-cli that does not report it; update browser-cli there): https://example.com/report');
  });

  test('the OS handler names its app when macOS did', () => {
    expect(describeShown({ via: 'open', app: 'Safari', visible: false, frontmost: 'Terminal', notification: 'clickable' }, url))
      .toBe('Opened in Safari (behind Terminal); notification sent: https://example.com/report');
    expect(describeShown({ via: 'open', visible: false, frontmost: 'unknown', notification: 'none', unknownWhy: 'x' }, url))
      .toBe('Opened in the OS default browser; cannot tell whether the user can see it (x): https://example.com/report');
  });
});
