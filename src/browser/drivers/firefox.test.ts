import { describe, it, expect, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deserializeBidi,
  FirefoxCapabilityError,
  firefoxAttachRequiredError,
  firefoxExitedError,
  connectFirefox,
  FirefoxBiDiClient,
  bidiCreateTab,
  bidiNavigate,
  bidiEvaluate,
  bidiScreenshot,
  bidiTopLevelContexts,
  bidiCloseTab,
  bidiClickAt,
  type FirefoxConnection,
} from './firefox.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

describe('deserializeBidi', () => {
  it('unwraps primitives, arrays, and plain objects into a JS value', () => {
    expect(deserializeBidi({ type: 'string', value: 'hi' })).toBe('hi');
    expect(deserializeBidi({ type: 'number', value: 42 })).toBe(42);
    expect(deserializeBidi({ type: 'boolean', value: true })).toBe(true);
    expect(deserializeBidi({ type: 'null' })).toBeNull();
    expect(deserializeBidi({ type: 'undefined' })).toBeUndefined();
    expect(
      deserializeBidi({ type: 'array', value: [{ type: 'number', value: 1 }, { type: 'string', value: 'x' }, { type: 'null' }] }),
    ).toEqual([1, 'x', null]);
    expect(
      deserializeBidi({
        type: 'object',
        value: [
          ['t', { type: 'string', value: 'Title' }],
          ['n', { type: 'number', value: 2 }],
          ['nested', { type: 'object', value: [['a', { type: 'boolean', value: true }]] }],
        ],
      }),
    ).toEqual({ t: 'Title', n: 2, nested: { a: true } });
  });

  it('maps the string-encoded specials number BiDi uses', () => {
    expect(deserializeBidi({ type: 'number', value: 'Infinity' })).toBe(Infinity);
    expect(deserializeBidi({ type: 'number', value: '-Infinity' })).toBe(-Infinity);
    expect(Number.isNaN(deserializeBidi({ type: 'number', value: 'NaN' }) as number)).toBe(true);
  });

  it('yields undefined for a node/window RemoteValue that has no JS value', () => {
    expect(deserializeBidi({ type: 'node' })).toBeUndefined();
    expect(deserializeBidi({ type: 'window' })).toBeUndefined();
  });
});

describe('FirefoxCapabilityError', () => {
  it('names the missing capability and steers to a Chromium-family profile', () => {
    const err = new FirefoxCapabilityError('pdf');
    expect(err.capability).toBe('pdf');
    expect(err.message).toContain('pdf');
    expect(err.message.toLowerCase()).toContain('chromium');
  });
});

describe('firefoxAttachRequiredError', () => {
  it('names the exact relaunch command with port and profile directory', () => {
    const err = firefoxAttachRequiredError(
      { name: 'firefox-default', firefox: { profileName: 'default' } },
      9652,
      '/home/u/.mozilla/firefox/abc.default',
    );
    expect(err.message).toContain('firefox-default');
    expect(err.message).toContain('9652');
    expect(err.message).toContain('--remote-debugging-port 9652');
    expect(err.message).toContain('/home/u/.mozilla/firefox/abc.default');
    expect(err.message).toContain('single-instance');
  });
});

describe('firefoxExitedError', () => {
  it('names the binary that exited and the profile it could not open', () => {
    const err = firefoxExitedError({ name: 'firefox-default' }, '/opt/ff/firefox', '/home/u/.config/mozilla/firefox/abc.default');
    expect(err.message).toContain('exited right after launch');
    expect(err.message).toContain('/opt/ff/firefox');
    expect(err.message).toContain('/home/u/.config/mozilla/firefox/abc.default');
    expect(err.message).not.toContain('snap');
  });

  it.skipIf(process.platform === 'win32')('is raised on Linux when the launched binary exits at once; elsewhere the profile is assumed held', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-exit-'));
    const binary = path.join(dir, 'firefox');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const profileDir = path.join(dir, 'abc.default');
    fs.mkdirSync(profileDir);
    const profile: BrowserProfile = {
      name: 'firefox-exits',
      browser: 'firefox',
      binary,
      endpoints: { bidi: { target: 'firefox-bidi://127.0.0.1:9679' } },
      defaultEndpoint: 'bidi',
      userDataDir: profileDir,
      firefox: { profileName: 'abc', iniPath: path.join(dir, 'profiles.ini'), isDefault: false },
    };
    try {
      const expected = process.platform === 'linux' ? /exited right after launch[\s\S]*binary: {2}.*firefox/ : /already running/;
      await expect(connectFirefox(profile, 'firefox-exits@local' as ConnectionKey, 9679, { profileDir, headless: true }))
        .rejects.toThrow(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('FirefoxBiDiClient.connect', () => {
  // A cold launch polls the port before Firefox opens it. Bun emits 'error'
  // twice per refused connect, and an unheard one stopped the service.
  it('rejects on a refused port without leaving an error unheard', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    for (let i = 0; i < 10; i++) {
      await expect(new FirefoxBiDiClient().connect(`ws://127.0.0.1:${port}/session`)).rejects.toThrow('WebSocket error');
    }
    await new Promise((r) => setTimeout(r, 200));
  });
});

// ─── Live BiDi transport against a real headless Firefox ───────────────────────
// Gated on AGENTS_TEST_FIREFOX=<firefox binary>; skips cleanly when unset.
const FIREFOX = process.env.AGENTS_TEST_FIREFOX;
const haveFirefox = !!(FIREFOX && fs.existsSync(FIREFOX));
const live = haveFirefox ? describe : describe.skip;

// A snap Firefox cannot start under the sandbox $HOME and only reads profiles
// under ~/snap/firefox/common; os.userInfo() reads passwd, so it finds the real
// home. Without a snap tree a plain temp dir works.
const realHome = os.userInfo().homedir;
const snapMozilla = path.join(realHome, 'snap', 'firefox', 'common', '.mozilla');
const useSnap = fs.existsSync(path.join(realHome, 'snap', 'firefox'));
function makeProfileDir(prefix: string): string {
  const base = useSnap ? snapMozilla : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

live('Firefox BiDi driver against real Firefox', () => {
  const profileDir = haveFirefox ? makeProfileDir('ff-driver-live-') : '';
  let conn: FirefoxConnection;
  const savedHome = process.env.HOME;
  // Give the spawned Firefox the real HOME (snap needs it); restore after.
  if (haveFirefox) process.env.HOME = realHome;

  const profile: BrowserProfile = {
    name: 'firefox-live-test',
    browser: 'firefox',
    binary: FIREFOX,
    endpoints: { bidi: { target: 'firefox-bidi://127.0.0.1:9671' } },
    defaultEndpoint: 'bidi',
    userDataDir: profileDir,
    firefox: { profileName: 'live-test', iniPath: path.join(profileDir, 'profiles.ini'), isDefault: false },
  };

  afterAll(async () => {
    try { conn?.bidi.close(); } catch { /* ignore */ }
    if (conn?.pid) { try { process.kill(conn.pid, 'SIGKILL'); } catch { /* already gone */ } }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  });

  it('launches Firefox, opens a session, and drives create/navigate/evaluate/screenshot', async () => {
    conn = await connectFirefox(profile, 'firefox-live-test@local' as ConnectionKey, 9671, { profileDir, headless: true });
    expect(conn.sessionId).toBeTruthy();
    expect(conn.bidi.isOpen).toBe(true);

    const ctx = await bidiCreateTab(conn.bidi);
    await bidiNavigate(conn.bidi, ctx, 'data:text/html,<title>BiDi</title><h1 id=h>hello</h1>');

    const value = await bidiEvaluate(conn.bidi, ctx, '({ t: document.title, h: document.getElementById("h").textContent })');
    expect(value).toEqual({ t: 'BiDi', h: 'hello' });

    // A thrown expression surfaces as an Error, not a silent undefined.
    await expect(bidiEvaluate(conn.bidi, ctx, 'throw new Error("boom")')).rejects.toThrow(/boom/);

    const png = await bidiScreenshot(conn.bidi, ctx, { type: 'image/png' });
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const contexts = await bidiTopLevelContexts(conn.bidi);
    expect(contexts.some((c) => c.context === ctx)).toBe(true);

    await bidiCloseTab(conn.bidi, ctx);
    const after = await bidiTopLevelContexts(conn.bidi);
    expect(after.some((c) => c.context === ctx)).toBe(false);
  }, 60_000);

  it('performs a trusted pointer click via input.performActions', async () => {
    const ctx = await bidiCreateTab(conn.bidi);
    await bidiNavigate(
      conn.bidi,
      ctx,
      'data:text/html,<button id=b style="position:absolute;left:10px;top:10px;width:120px;height:40px" ' +
        'onclick="window.__clicked=true">Go</button>',
    );
    await bidiClickAt(conn.bidi, ctx, 60, 30);
    const clicked = await bidiEvaluate(conn.bidi, ctx, 'window.__clicked === true');
    expect(clicked).toBe(true);
    await bidiCloseTab(conn.bidi, ctx);
  }, 60_000);

  it('fails loud when a Firefox already holds the profile without a debug port', async () => {
    // The profile dir is locked by our launched Firefox; a second connect that is
    // NOT allowed to attach (wrong port with no server) must raise the relaunch
    // error rather than silently launching a rival.
    const busy: BrowserProfile = { ...profile, userDataDir: profileDir };
    await expect(
      connectFirefox(busy, 'firefox-live-test@local2' as ConnectionKey, 9673, { profileDir, headless: true }),
    ).rejects.toThrow(/single-instance|never exposed|already running/i);
  }, 60_000);
});
