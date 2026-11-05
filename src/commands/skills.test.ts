import { describe, expect, it } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error -- plain .mjs release helper, no type declarations
import { isPublishedFileAllowed } from '../../scripts/published-files.mjs';

const REPO = join(import.meta.dir, '..', '..');
const SKILLS = join(REPO, 'skills');

async function cli(args: string[], env: Record<string, string | undefined> = { BROWSER_SKILLS_DIR: SKILLS }) {
  const child = Bun.spawn([process.execPath, join(REPO, 'src', 'index.ts'), ...args], {
    env: { ...process.env, BROWSER_SKILLS_DIR: undefined, BROWSER_CONTEXT_FD: undefined, BROWSER_EVENTS_FD: undefined, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe('browser skills', () => {
  it('path prints the installed skills/browser directory', async () => {
    const r = await cli(['skills', 'path']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(join(SKILLS, 'browser'));
  });

  it('list names SKILL.md, the Arc notes and every site guide', async () => {
    const r = await cli(['skills', 'list', '--json']);
    expect(r.code).toBe(0);
    const names = JSON.parse(r.stdout).map((d: { name: string }) => d.name);
    expect(names[0]).toBe('browser');
    expect(names).toEqual(expect.arrayContaining(['arc', 'sites/higgsfield', 'sites/linkedin', 'sites/perplexity', 'sites/slack']));
  });

  it('get prints SKILL.md by default and resolves a bare site name', async () => {
    const skill = await cli(['skills', 'get']);
    expect(skill.code).toBe(0);
    expect(skill.stdout).toBe(readFileSync(join(SKILLS, 'browser', 'SKILL.md'), 'utf8').trimEnd() + '\n');
    const slack = await cli(['skills', 'get', 'slack']);
    expect(slack.code).toBe(0);
    expect(slack.stdout).toContain('# Slack');
  });

  it('fails loud on an unknown document and when the skill cannot be located', async () => {
    const unknown = await cli(['skills', 'get', 'nope']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No skill document "nope". Available: browser, arc');
    const unset = await cli(['skills', 'path'], {});
    expect(unset.code).toBe(1);
    expect(unset.stderr).toContain('BROWSER_SKILLS_DIR is not set');
  });
});

describe('browser help', () => {
  it('--json prints the whole command tree with each command\'s real options', async () => {
    const r = await cli(['help', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    const start = doc.tree.find((c: { path: string }) => c.path === 'start');
    expect(start.options.map((o: { long: string }) => o.long)).toEqual(expect.arrayContaining(['--profile', '--url', '--task']));
    expect(doc.tree.map((c: { path: string }) => c.path)).toEqual(expect.arrayContaining(['skills', 'help']));
    // The checked-in reference is the same tree.
    expect(doc.tree).toEqual(JSON.parse(readFileSync(join(REPO, 'docs', 'command-index.json'), 'utf8')).tree);
  });

  it('names one nested command, prints plain help, and rejects an unknown command', async () => {
    const nested = await cli(['help', 'profiles', 'create', '--json']);
    expect(nested.code).toBe(0);
    expect(JSON.parse(nested.stdout).path).toBe('profiles create');
    const plain = await cli(['help', 'start']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('Usage: browser start [options]');
    const bad = await cli(['help', 'bogus']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Unknown command: browser bogus');
  });
});

describe('npm package', () => {
  it('the launcher hands the binary its own package\'s skills directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-launcher-'));
    try {
      const pkg = join(root, 'node_modules', '@phnx-labs', 'browser-cli');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      copyFileSync(join(REPO, 'bin', 'browser.cjs'), join(pkg, 'bin', 'browser.cjs'));
      symlinkSync(SKILLS, join(pkg, 'skills'));
      // A stand-in platform binary that reports what the launcher passed it.
      const platformPkg = join(root, 'node_modules', '@phnx-labs', `browser-cli-${process.platform}-${process.arch}`);
      mkdirSync(platformPkg, { recursive: true });
      writeFileSync(join(platformPkg, 'package.json'), '{"name":"stub","version":"0.0.0"}');
      writeFileSync(join(platformPkg, 'browser'), '#!/bin/sh\nprintf "%s" "$BROWSER_SKILLS_DIR"\n');
      chmodSync(join(platformPkg, 'browser'), 0o755);
      // A stray inherited value must not replace the package's own skill.
      const env = { ...process.env, BROWSER_SKILLS_DIR: join(root, 'elsewhere') };
      const r = spawnSync('node', [join(pkg, 'bin', 'browser.cjs')], { env, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(join(pkg, 'skills'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('postinstall swaps in the platform binary only when it answers with this version', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-postinstall-'));
    try {
      const pkg = join(root, 'node_modules', '@phnx-labs', 'browser-cli');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      for (const file of ['browser.cjs', 'install.cjs']) copyFileSync(join(REPO, 'bin', file), join(pkg, 'bin', file));
      writeFileSync(join(pkg, 'package.json'), '{"name":"@phnx-labs/browser-cli","version":"9.9.9"}');
      const platformPkg = join(root, 'node_modules', '@phnx-labs', `browser-cli-${process.platform}-${process.arch}`);
      mkdirSync(platformPkg, { recursive: true });
      writeFileSync(join(platformPkg, 'package.json'), '{"name":"stub","version":"0.0.0"}');
      const bin = join(pkg, 'bin', 'browser.cjs');
      const install = (agent: string) => spawnSync('node', [join(pkg, 'bin', 'install.cjs')], {
        env: { ...process.env, npm_config_user_agent: agent }, encoding: 'utf8',
      });
      const launcher = readFileSync(join(REPO, 'bin', 'browser.cjs'), 'utf8');
      // A binary that reports another version keeps the JavaScript launcher.
      writeFileSync(join(platformPkg, 'browser'), '#!/bin/sh\necho 1.0.0\n');
      chmodSync(join(platformPkg, 'browser'), 0o755);
      expect(install('npm/11.6.2 node/v24.0.0').status).toBe(0);
      expect(readFileSync(bin, 'utf8')).toBe(launcher);
      const native = '#!/bin/sh\necho 9.9.9\n';
      writeFileSync(join(platformPkg, 'browser'), native);
      // pnpm and yarn shims run the bin with node, so they keep the launcher.
      expect(install('pnpm/10.0.0 npm/? node/v24.0.0').status).toBe(0);
      expect(readFileSync(bin, 'utf8')).toBe(launcher);
      // npm, then bun over an already swapped bin (one inode under two names).
      for (const agent of ['npm/11.6.2 node/v24.0.0', 'bun/1.4.1 npm/? node/v24.0.0']) {
        expect(install(agent).status).toBe(0);
        expect(readFileSync(bin, 'utf8')).toBe(native);
        expect(spawnSync(bin, { encoding: 'utf8' }).stdout).toBe('9.9.9\n');
        expect(readdirSync(join(pkg, 'bin')).sort()).toEqual(['browser.cjs', 'install.cjs']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('npm pack ships the skill, and release accepts every packed file', () => {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const files = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path);
    expect(files).toEqual(expect.arrayContaining([
      'skills/browser/SKILL.md',
      'skills/browser/references/arc.md',
      'skills/browser/references/sites/slack.md',
      'skills/browser/scripts/slack/find-ids.js',
    ]));
    // release.mjs refuses to publish a file outside this allowlist.
    expect(files.filter((f: string) => !isPublishedFileAllowed(f, { launcher: true }))).toEqual([]);
    expect(isPublishedFileAllowed('skills/other/SKILL.md', { launcher: true })).toBe(false);
    expect(isPublishedFileAllowed('skills/browser/SKILL.md', { launcher: false })).toBe(false);
  });

  it('SKILL.md follows the Agent Skills naming rules', () => {
    const text = readFileSync(join(SKILLS, 'browser', 'SKILL.md'), 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
    const name = fm.match(/^name:\s*(.+)$/m)?.[1].trim();
    const description = fm.match(/^description:\s*(.+)$/m)?.[1].trim() ?? '';
    expect(name).toBe('browser');
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
