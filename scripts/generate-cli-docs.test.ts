import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/generate-cli-docs.sh');
const files = ['command-reference.html', 'command-index.md', 'command-index.json'];
const scratch = tmpdir();

function run(path: string, args: string[], cwd: string, env = process.env) {
  return spawnSync('bash', [path, ...args], { cwd, env, encoding: 'utf8', timeout: 20_000 });
}

test('generates the real command tree from another cwd; check detects drift without writing', () => {
  const cwd = mkdtempSync(join(scratch, 'cli-docs-'));
  const args = ['--out-dir', 'preview with spaces'];
  const out = join(cwd, args[1]);
  try {
    const result = run(script, args, cwd);
    expect(result.status, result.stderr).toBe(0);
    const original = files.map(file => readFileSync(join(out, file), 'utf8'));
    const tree = JSON.parse(original[2]);
    expect(tree.root.name).toBe('browser');
    expect(tree.commands).toBeGreaterThan(0);
    expect(original[0]).toContain('<nav');
    expect(original[0]).toContain('navigate');
    const mtimes = files.map(file => statSync(join(out, file)).mtimeMs);
    expect(run(script, [...args, '--check'], cwd).status).toBe(0);
    expect(files.map(file => statSync(join(out, file)).mtimeMs)).toEqual(mtimes);
    writeFileSync(join(out, files[0]), 'stale');
    rmSync(join(out, files[2]));
    const stale = run(script, [...args, '--check'], cwd);
    expect(stale.status).toBe(1);
    expect(stale.stderr + stale.stdout).toContain(files[0]);
    expect(stale.stderr + stale.stdout).toContain(files[2]);
    expect(readFileSync(join(out, files[0]), 'utf8')).toBe('stale');
    expect(run(script, args, cwd).status).toBe(0);
    expect(files.map(file => readFileSync(join(out, file), 'utf8'))).toEqual(original);
    // The default check resolves this repository's docs/, not cwd/docs/.
    expect(run(script, ['--check'], cwd).status).toBe(0);
    expect(run(script, ['--chek'], cwd).status).not.toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test('the real release entry point rejects missing docs before it pushes a release branch', () => {
  const cwd = mkdtempSync(join(scratch, 'release-docs-'));
  try {
    mkdirSync(join(cwd, 'scripts'));
    for (const file of ["release.sh", "generate-cli-docs.sh", "gen-docs.ts", "release.mjs", "published-files.mjs"]) {
      copyFileSync(join(root, 'scripts', file), join(cwd, 'scripts', file));
    }
    symlinkSync(join(root, 'src'), join(cwd, 'src'), 'dir');
    symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    const { GITHUB_ACTIONS: _, ...env } = process.env;
    const result = run(join(cwd, 'scripts/release.sh'), ['--confirm'], cwd, env);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('command-reference.html');
    expect(result.stderr + result.stdout).toContain('scripts/generate-cli-docs.sh');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
