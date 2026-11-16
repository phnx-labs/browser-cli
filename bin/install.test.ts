import { afterEach, beforeEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let bin: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-postinstall-'));
  bin = path.join(root, 'node_modules', '@phnx-labs', 'browser-cli', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, 'install.cjs'), path.join(bin, 'install.cjs'));
  fs.writeFileSync(path.join(bin, 'browser.cjs'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'ran'))}, process.argv.slice(2).join(' '));\n`);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function postinstall(extra: Record<string, string>): boolean {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: root, npm_config_global: 'true', ...extra };
  const run = Bun.spawnSync([Bun.which('node') ?? process.execPath, path.join(bin, 'install.cjs')], { env, stdin: 'ignore' });
  expect(run.exitCode).toBe(0);
  return fs.existsSync(path.join(root, 'ran'));
}

it('a global install runs `browser doctor --local` once', () => {
  expect(postinstall({})).toBe(true);
  expect(fs.readFileSync(path.join(root, 'ran'), 'utf8')).toBe('doctor --local');
});

it.each(['BROWSER_NO_UPDATE_NOTIFIER', 'CI', 'CODESPACES', 'BUILD_NUMBER', 'RUN_ID'])('does nothing with %s set', (key) => {
  expect(postinstall({ [key]: '1' })).toBe(false);
});
