import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAndResolveBundleEnv } from './secrets.js';

const hasSecrets = spawnSync('secrets', ['--version']).status === 0;

describe.skipIf(!hasSecrets)('readAndResolveBundleEnv against the real secrets CLI', () => {
  it('returns exact values, including spaces, quotes and newlines', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bcli-secrets-'));
    const prev = { HOME: process.env.HOME, SECRETS_HOME: process.env.SECRETS_HOME };
    process.env.HOME = home;
    process.env.SECRETS_HOME = home;
    try {
      const run = (...a: string[]) => expect(spawnSync('secrets', a, { env: process.env }).status).toBe(0);
      run('create', 'example.com', '--description', 'test');
      run('add', 'example.com', 'PASSWORD', '--value', `p a"s's\nword`);
      run('add', 'example.com', 'LOGIN', '--value', 'ada');
      expect((await readAndResolveBundleEnv('example.com', { keys: ['PASSWORD'] })).env).toEqual({ PASSWORD: `p a"s's\nword` });
      expect((await readAndResolveBundleEnv('example.com')).env).toEqual({ PASSWORD: `p a"s's\nword`, LOGIN: 'ada' });
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.SECRETS_HOME === undefined) delete process.env.SECRETS_HOME;
      else process.env.SECRETS_HOME = prev.SECRETS_HOME;
    }
  });
});
