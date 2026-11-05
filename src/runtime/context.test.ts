import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseContext,
  loadContext,
  resolveContextDevice,
  resetContextCache,
  CONTEXT_FD_ENV,
} from './context.js';

const tmpdirs: string[] = [];
function tmpFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ctx-'));
  tmpdirs.push(dir);
  const file = path.join(dir, 'context.json');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  resetContextCache();
  for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseContext', () => {
  it('accepts a version-1 document and preserves every seam field', () => {
    const ctx = parseContext(JSON.stringify({
      version: 1,
      target: { alias: 'laptop', host: 'user@10.0.0.5', platform: 'darwin', sshArgs: ['-i', '/k'] },
      session: { sessionId: 's1', actor: 'claude' },
      remoteControl: { allowed: true },
    }));
    expect(ctx.target?.host).toBe('user@10.0.0.5');
    expect(ctx.target?.sshArgs).toEqual(['-i', '/k']);
    expect(ctx.session?.actor).toBe('claude');
    expect(ctx.remoteControl?.allowed).toBe(true);
  });

  it('rejects a future version rather than guessing at its shape', () => {
    expect(() => parseContext('{"version":2}')).toThrow(/unsupported browser context version 2/);
  });

  it('rejects malformed JSON and non-objects instead of degrading to defaults', () => {
    expect(() => parseContext('{nope')).toThrow(/not valid JSON/);
    expect(() => parseContext('[]')).toThrow(/must be a JSON object/);
    expect(() => parseContext('"hi"')).toThrow(/must be a JSON object/);
  });

  it('rejects a session whose identity fields are not strings', () => {
    expect(() => parseContext('{"version":1,"session":"s1"}')).toThrow(/context session/);
    expect(() => parseContext('{"version":1,"session":{"launchId":["l1"]}}')).toThrow(/context session/);
  });

  it('rejects a target with no usable host', () => {
    expect(() => parseContext('{"version":1,"target":{"platform":"darwin"}}')).toThrow(/target.host must be a string/);
  });
});

describe('loadContext', () => {
  it('returns null when no context is passed — the standalone case is not an error', () => {
    expect(loadContext({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads a real inherited file descriptor to EOF', () => {
    const file = tmpFile(JSON.stringify({ version: 1, session: { actor: 'claude' } }));
    const fd = fs.openSync(file, 'r');
    try {
      const ctx = loadContext({ [CONTEXT_FD_ENV]: String(fd) } as unknown as NodeJS.ProcessEnv);
      expect(ctx?.session?.actor).toBe('claude');
    } finally {
      fs.closeSync(fd);
    }
  });

  it('rejects a non-numeric descriptor', () => {
    expect(() => loadContext({ [CONTEXT_FD_ENV]: 'stdin' } as unknown as NodeJS.ProcessEnv)).toThrow(/must be a file descriptor number/);
  });
});

describe('resolveContextDevice', () => {
  const descriptors: number[] = [];
  afterEach(() => { for (const fd of descriptors.splice(0)) fs.closeSync(fd); });
  const env = (ctx: unknown) => {
    const fd = fs.openSync(tmpFile(JSON.stringify(ctx)), 'r');
    descriptors.push(fd);
    return { [CONTEXT_FD_ENV]: String(fd) } as NodeJS.ProcessEnv;
  };
  it('falls back to the single target when its alias matches', () => {
    const got = resolveContextDevice('box', env({ version: 1, target: { alias: 'box', host: 'u@h' } }));
    expect(got?.host).toBe('u@h');
  });

  it('returns null for an unknown alias so the caller can try ~/.ssh/config', () => {
    expect(resolveContextDevice('nope', env({ version: 1 }))).toBeNull();
  });
});
