import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  discoverEditorWindowsAt,
  editorEndpointsDir,
  editorWindowLabel,
  resolveEditorWsUrl,
} from './editor-discovery.js';

const TOKEN = 'a'.repeat(64);
const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid!;

function write(dir: string, file: string, body: Record<string, unknown> | string): void {
  fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
}

function endpoint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: '0b7c1e2a-1111-4c2b-9d1e-aaaaaaaaaaaa',
    app: 'VSCodium',
    appVersion: '1.135.0',
    workspace: 'agi-ext',
    pid: process.pid,
    port: 49321,
    token: TOKEN,
    startedAt: '2026-11-12T12:00:00.000Z',
    ...over,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-discovery-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTS_HOME;
});

describe('discoverEditorWindowsAt', () => {
  it('names a live window <app>-<workspace> and keeps its endpoint', () => {
    write(dir, 'a.json', endpoint());
    const found = discoverEditorWindowsAt(dir);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.windows).toHaveLength(1);
    expect(found.windows[0]).toMatchObject({ name: 'vscodium-agi-ext', port: 49321, token: TOKEN, workspace: 'agi-ext' });
  });

  it('skips a window whose process is gone (a crashed editor leaves its file)', () => {
    write(dir, 'live.json', endpoint());
    write(dir, 'dead.json', endpoint({ id: '0b7c1e2a-2222-4c2b-9d1e-bbbbbbbbbbbb', workspace: 'gone', pid: DEAD_PID }));
    const found = discoverEditorWindowsAt(dir);
    expect(found.ok && found.windows.map((w) => w.name)).toEqual(['vscodium-agi-ext']);
  });

  it('skips malformed files instead of hiding every other window', () => {
    write(dir, 'good.json', endpoint());
    write(dir, 'torn.json', '{"v":1,"id":');
    write(dir, 'future.json', endpoint({ v: 2, id: '0b7c1e2a-3333-4c2b-9d1e-cccccccccccc' }));
    write(dir, 'no-token.json', endpoint({ id: '0b7c1e2a-4444-4c2b-9d1e-dddddddddddd', token: 'short' }));
    const found = discoverEditorWindowsAt(dir);
    expect(found.ok && found.windows.map((w) => w.name)).toEqual(['vscodium-agi-ext']);
  });

  it('keeps two windows on one workspace distinct by id, and names an empty window', () => {
    write(dir, 'a.json', endpoint());
    write(dir, 'b.json', endpoint({ id: '9f00aa11-5555-4c2b-9d1e-eeeeeeeeeeee', startedAt: '2026-11-12T12:05:00.000Z' }));
    write(dir, 'c.json', endpoint({ id: '7e00bb22-6666-4c2b-9d1e-ffffffffffff', app: 'Visual Studio Code', workspace: null }));
    const found = discoverEditorWindowsAt(dir);
    expect(found.ok && found.windows.map((w) => w.name).sort()).toEqual([
      'vscode-window',
      'vscodium-agi-ext-0b7c1e',
      'vscodium-agi-ext-9f00aa',
    ]);
  });

  it('treats a missing directory as no windows', () => {
    expect(discoverEditorWindowsAt(path.join(dir, 'absent'))).toEqual({ ok: true, windows: [] });
  });
});

describe('editorWindowLabel', () => {
  it('says which window a row stands for', () => {
    expect(editorWindowLabel({ app: 'VSCodium', workspace: 'agi-ext' })).toBe('VSCodium window "agi-ext"');
    expect(editorWindowLabel({ app: 'VSCodium', workspace: null })).toBe('VSCodium window (no folder)');
  });
});

describe('resolveEditorWsUrl', () => {
  it('reads the runtime dir and returns the tokenized loopback URL, matching the id case-insensitively', () => {
    process.env.AGENTS_HOME = dir;
    fs.mkdirSync(editorEndpointsDir(), { recursive: true });
    write(editorEndpointsDir(), 'a.json', endpoint({ id: '0B7C1E2A-1111-4C2B-9D1E-AAAAAAAAAAAA' }));
    const id = new URL('editor://0B7C1E2A-1111-4C2B-9D1E-AAAAAAAAAAAA').hostname;
    expect(resolveEditorWsUrl(id, 'vscodium-agi-ext')).toBe(`ws://127.0.0.1:49321/devtools/browser/${TOKEN}`);
  });

  it('fails loud and names the fix when the window closed', () => {
    process.env.AGENTS_HOME = dir;
    expect(() => resolveEditorWsUrl('0b7c1e2a-1111-4c2b-9d1e-aaaaaaaaaaaa', 'vscodium-agi-ext')).toThrow(
      /no longer open.*browser profiles list/,
    );
  });
});

describe('editor rows in the profile store', () => {
  it('lists an open window as an attach-only editor profile that is hostable here, and not once it closes', async () => {
    process.env.AGENTS_HOME = dir;
    const { discoverNativeProfiles, isProfileLaunchableHere } = await import('./profiles.js');
    fs.mkdirSync(editorEndpointsDir(), { recursive: true });
    const file = path.join(editorEndpointsDir(), 'a.json');
    write(editorEndpointsDir(), 'a.json', endpoint());
    const row = discoverNativeProfiles().profiles.find((p) => p.browser === 'editor');
    expect(row).toMatchObject({
      name: 'vscodium-agi-ext',
      label: 'VSCodium window "agi-ext"',
      launchPolicy: 'attach-only',
      endpoints: { editor: { target: 'editor://0b7c1e2a-1111-4c2b-9d1e-aaaaaaaaaaaa' } },
    });
    expect(isProfileLaunchableHere(row!)).toBe(true);
    fs.rmSync(file);
    expect(discoverNativeProfiles().profiles.some((p) => p.browser === 'editor')).toBe(false);
    expect(isProfileLaunchableHere(row!)).toBe(false);
  });
});
