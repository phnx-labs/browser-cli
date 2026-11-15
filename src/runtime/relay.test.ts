import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relayExec, relayFetchFile, relayFromEnv } from './relay.js';

interface Seen {
  path: string;
  auth: string | null;
  body: { argv?: string[]; env?: Record<string, string>; path?: string };
}

const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Seen['body'];
      const pathname = new URL(req.url).pathname;
      seen.push({ path: pathname, auth: req.headers.get('authorization'), body });
      if (pathname.startsWith('/devices/offline-mac/')) {
        return Response.json({ error: '"offline-mac" has no live link', code: 'DEVICE_OFFLINE', requestId: 'r1' }, { status: 409 });
      }
      if (pathname.endsWith('/file')) return Response.json({ base64: Buffer.from('PNGDATA').toString('base64') });
      if (body.argv?.[0] === 'start') return Response.json({ code: 0, stdout: 'relay-task-1\n', stderr: '' });
      return Response.json({ code: 3, stdout: `ran ${body.argv?.join(' ')}\n`, stderr: 'warn\n' });
    },
  });
  url = `http://127.0.0.1:${server.port}/devices`;
});

afterAll(() => server.stop(true));

describe('relayFromEnv', () => {
  test('unset means ssh', () => {
    expect(relayFromEnv({})).toBeNull();
  });

  test('the bearer never travels over plain http off loopback', () => {
    expect(() => relayFromEnv({ BROWSER_RELAY_URL: 'http://relay.example.com/devices', BROWSER_RELAY_TOKEN: 't' })).toThrow(/must be an https URL/);
    expect(relayFromEnv({ BROWSER_RELAY_URL: 'https://relay.example.test/x/', BROWSER_RELAY_TOKEN: 't' })).toEqual({ url: 'https://relay.example.test/x', token: 't' });
  });

  test('a URL without a token fails closed', () => {
    expect(() => relayFromEnv({ BROWSER_RELAY_URL: url })).toThrow(/BROWSER_RELAY_TOKEN is empty/);
  });
});

describe('relayExec and relayFetchFile against a live relay', () => {
  const relay = () => ({ url, token: 'run-token' });

  test('sends argv as words, not a shell line, with the bearer and env', async () => {
    const hostile = ['$(id)', "it's", 'a b'];
    const result = await relayExec(relay(), 'laptop', ['browser', 'click', ...hostile], { AGENTS_FLEET_REMOTE: '1' });

    expect(result).toEqual({ code: 3, stdout: `ran click ${hostile.join(' ')}\n`, stderr: 'warn\n' });
    const last = seen.at(-1)!;
    expect(last.path).toBe('/devices/laptop/exec');
    expect(last.auth).toBe('Bearer run-token');
    expect(last.body).toEqual({ argv: ['click', ...hostile], env: { AGENTS_FLEET_REMOTE: '1' } });
  });

  test('a refusal surfaces its code', async () => {
    await expect(relayExec(relay(), 'offline-mac', ['navigate', 'x'], {})).rejects.toThrow('DEVICE_OFFLINE: "offline-mac" has no live link');
  });

  test('fetches a file body', async () => {
    expect((await relayFetchFile(relay(), 'laptop', '/tmp/shot.png')).toString()).toBe('PNGDATA');
    expect(seen.at(-1)!.body).toEqual({ path: '/tmp/shot.png' });
  });
});

describe.skipIf(process.platform === 'win32')('browser start --device over the relay', () => {
  test('the real CLI forwards start to the relay and binds the returned task', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-home-'));
    const proc = Bun.spawn(['bun', path.join(import.meta.dir, '..', 'index.ts'), 'start', '--device', 'laptop', '--profile', 'arc-work'], {
      env: { ...process.env, AGENTS_HOME: home, HOME: home, BROWSER_RELAY_URL: url, BROWSER_RELAY_TOKEN: 'run-token' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    const nav = Bun.spawn(['bun', path.join(import.meta.dir, '..', 'index.ts'), 'navigate', 'https://example.com', '--task', 'relay-task-1'], {
      env: { ...process.env, AGENTS_HOME: home, HOME: home, BROWSER_RELAY_URL: url, BROWSER_RELAY_TOKEN: 'run-token' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const navOutput = await new Response(nav.stdout).text();
    const navCode = await nav.exited;
    fs.rmSync(home, { recursive: true, force: true });

    const forwarded = seen.findLast((s) => s.body.argv?.[0] === 'start');
    expect(forwarded?.path).toBe('/devices/laptop/exec');
    expect(forwarded?.body.argv).toEqual(['start', '--profile', 'arc-work']);
    expect(forwarded?.body.env?.AGENTS_FLEET_REMOTE).toBe('1');
    expect(output).toContain('relay-task-1');
    const navigated = seen.findLast((x) => x.body.argv?.[0] === 'navigate');
    expect(navigated?.path).toBe('/devices/laptop/exec');
    expect(navigated?.body.argv).toContain('https://example.com');
    expect(navOutput).toContain('ran navigate');
    expect(navCode).toBe(3);
  });
});
