import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  browsersOnPath,
  checkInstallHealth,
  NOTIFIER_OPT_OUT,
  noticeAllowed,
  noticeLine,
  resolveInShell,
  type Shadow,
} from './install-health.js';

const REPO = path.join(import.meta.dir, '..', '..');
const TESTDATA = path.join(import.meta.dir, 'testdata', 'install-health');
const OLD = path.join(TESTDATA, 'two-copies', 'old');
const NEW = path.join(TESTDATA, 'two-copies', 'new');
const ZSH = Bun.which('zsh');
const SYSTEM_PATH = ['/usr/bin', '/bin'];

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-doctor-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function rcDir(name: string): string {
  const dir = path.join(home, name);
  fs.cpSync(path.join(TESTDATA, name), dir, { recursive: true });
  return dir;
}

function shellEnv(zdotdir: string, dirs: string[] = SYSTEM_PATH): NodeJS.ProcessEnv {
  return { HOME: home, ZDOTDIR: zdotdir, SHELL: ZSH ?? 'zsh', PATH: dirs.join(path.delimiter), TERM: 'dumb' };
}

describe.skipIf(!ZSH)('browser doctor with a real zsh', () => {
  it('names the rc file and line of an alias that shadows browser, and the fix', async () => {
    const zdotdir = rcDir('zsh-alias');
    const child = Bun.spawn([process.execPath, path.join(REPO, 'src', 'index.ts'), 'doctor', '--local', '--json'], {
      env: { ...process.env, ...shellEnv(zdotdir), AGENTS_HOME: path.join(home, '.agents'), BROWSER_SKILLS_DIR: undefined },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const report = JSON.parse(stdout) as { ok: boolean; checks: Array<{ label: string; ok: boolean; detail: string; fix?: string }> };
    expect(code).toBe(1);
    expect(report.ok).toBe(false);
    const shell = report.checks.find((c) => c.label === 'shell')!;
    const rc = '~/zsh-alias/.zshrc';
    expect(shell).toMatchObject({ ok: false });
    expect(shell.detail).toBe(`zsh runs the alias browser='agents browser' from ${rc}:5, not this install`);
    expect(shell.fix).toBe(`delete line 5 of ${rc} (alias browser="agents browser"), then run \`unalias browser\` in shells already open`);
  });

  it('follows source lines and skips commented-out definitions', () => {
    const zdotdir = rcDir('zsh-sourced');
    const resolved = resolveInShell(ZSH!, shellEnv(zdotdir));
    expect(resolved).toMatchObject({
      kind: 'alias',
      definition: 'agents browser',
      definedAt: { file: path.join(zdotdir, 'aliases.zsh'), line: 3, text: "alias browser='agents browser'" },
    });
  });

  it('lists two browser executables on PATH with their versions and says the older one wins', async () => {
    const self = [path.join(NEW, 'browser')];
    const health = await checkInstallHealth({
      current: '0.2.15',
      local: true,
      self,
      env: shellEnv(rcDir('empty-zdotdir'), [OLD, NEW, ...SYSTEM_PATH]),
    });
    expect(health.onPath).toEqual([
      { file: path.join(OLD, 'browser'), version: '0.1.24', self: false, wins: true },
      { file: path.join(NEW, 'browser'), version: '0.2.15', self: true, wins: false },
    ]);
    expect(health.shadow).toMatchObject({ kind: 'file', summary: `zsh runs ${path.join(OLD, 'browser')} (0.1.24), not this install (${self[0]})` });
    expect(health.checks.map((c) => [c.label, c.ok])).toEqual([['shell', false], ['path', false], ['path', true]]);
    expect(health.checks[0].fix).toBe(`remove that copy with \`rm ${path.join(OLD, 'browser')}\`, or put ${NEW} before ${OLD} in PATH`);
  });

  it('is clean when this install is the only browser the shell finds', async () => {
    const health = await checkInstallHealth({
      current: '0.2.15',
      local: true,
      self: [path.join(NEW, 'browser')],
      env: shellEnv(rcDir('empty-zdotdir'), [NEW, ...SYSTEM_PATH]),
    });
    expect(health.checks).toEqual([
      { label: 'shell', ok: true, detail: `zsh runs ${path.join(NEW, 'browser')} (this install)` },
      { label: 'path', ok: true, detail: `${path.join(NEW, 'browser')} 0.2.15 (this install), wins` },
    ]);
  });
});

describe.skipIf(process.platform !== 'linux' || !Bun.which('bash'))('browser doctor with a real bash', () => {
  it('names ~/.bash_aliases and its line in the Debian layout, sourced from an indented line in ~/.bashrc', () => {
    const dir = rcDir('bash-debian');
    const resolved = resolveInShell(Bun.which('bash')!, { HOME: dir, PATH: SYSTEM_PATH.join(path.delimiter), TERM: 'dumb' });
    expect(resolved).toMatchObject({
      kind: 'alias',
      definition: 'agents browser',
      definedAt: { file: path.join(dir, '.bash_aliases'), line: 2, text: 'alias browser="agents browser"' },
    });
  });
});

it('a shadowed copy that loses on PATH is listed with the copy that wins', () => {
  const copies = browsersOnPath([NEW, OLD], [path.join(NEW, 'browser')], '0.2.15');
  expect(copies.map((c) => [c.version, c.wins])).toEqual([['0.2.15', true], ['0.1.24', false]]);
});

describe('the one-line notice', () => {
  const tty = { stdout: true, stderr: true };
  it('follows gh: off when opted out, in CI or Codespaces, under --json, or unless stdout and stderr are terminals', () => {
    expect(noticeAllowed(['browser', 'tabs'], {}, tty)).toBe(true);
    expect(noticeAllowed(['browser', 'tabs'], { [NOTIFIER_OPT_OUT]: '1' }, tty)).toBe(false);
    expect(noticeAllowed(['browser', 'tabs'], { CI: 'true' }, tty)).toBe(false);
    expect(noticeAllowed(['browser', 'tabs'], { BUILD_NUMBER: '7' }, tty)).toBe(false);
    expect(noticeAllowed(['browser', 'tabs'], { CODESPACES: 'true' }, tty)).toBe(false);
    expect(noticeAllowed(['browser', 'tabs', '--json'], {}, tty)).toBe(false);
    expect(noticeAllowed(['browser', 'tabs'], {}, { stdout: true, stderr: false })).toBe(false);
    expect(noticeAllowed(['browser', 'tabs'], {}, { stdout: false, stderr: true })).toBe(false);
  });

  it('puts a shadow first, names the opt-out, and goes quiet once the rc line is fixed', () => {
    const rc = path.join(home, '.zshrc');
    fs.writeFileSync(rc, 'alias browser="agents browser"\n');
    const shadow: Shadow = {
      shell: 'zsh', kind: 'alias', summary: `zsh runs the alias browser='agents browser' from ${rc}:1, not this install`, fix: '',
      definedAt: { file: rc, line: 1, text: 'alias browser="agents browser"' },
    };
    const cache = { checkedAt: Date.now(), latest: '9.0.0', shadow };
    expect(noticeLine(cache, '0.2.15', [])).toBe(
      `browser: ${shadow.summary}. Run \`browser doctor\` for the fix (${NOTIFIER_OPT_OUT}=1 hides this).`,
    );
    fs.writeFileSync(rc, '\n');
    expect(noticeLine(cache, '0.2.15', [])).toBe(
      `A new release of browser is available: 0.2.15 → 9.0.0. To upgrade, run: npm install -g @phnx-labs/browser-cli@latest (${NOTIFIER_OPT_OUT}=1 hides this).`,
    );
    expect(noticeLine({ checkedAt: Date.now(), latest: '0.2.15' }, '0.2.15', [])).toBeUndefined();
    fs.writeFileSync(rc, 'alias browser="agents browser"\n');
    expect(noticeLine({ ...cache, self: path.join(OLD, 'browser') }, '0.2.15', [path.join(NEW, 'browser')])).toStartWith('A new release');
  });

  it('names the hub when browser.device runs a newer version, and only that hub', () => {
    const cache = { checkedAt: Date.now(), hub: { device: 'zion', version: '0.2.16' } };
    expect(noticeLine(cache, '0.2.15', [], 'other-hub')).toBeUndefined();
    expect(noticeLine(cache, '0.2.15', [], 'zion')).toBe(
      `browser: zion (browser.device) runs 0.2.16, this machine 0.2.15. To upgrade, run: npm install -g @phnx-labs/browser-cli@latest (${NOTIFIER_OPT_OUT}=1 hides this).`,
    );
  });
});
