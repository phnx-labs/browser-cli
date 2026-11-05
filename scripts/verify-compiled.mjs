import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2]);
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
mkdirSync('.agents/scratch', { recursive: true });
const root = mkdtempSync(resolve('.agents/scratch/compiled-check-'));
const env = { ...process.env };
delete env.BROWSER_CONTEXT_FD;
delete env.BROWSER_EVENTS_FD;

function run(args, context) {
  let fd;
  if (context !== undefined) {
    writeFileSync(join(root, 'context.json'), context);
    fd = openSync(join(root, 'context.json'), 'r');
  }
  try {
    const result = spawnSync(binary, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...env, ...(fd === undefined ? {} : { BROWSER_CONTEXT_FD: '3' }) },
      stdio: ['ignore', 'pipe', 'pipe', ...(fd === undefined ? [] : [fd])],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function checkStatus(result) {
  // status exits 0 when the service is running, 1 when it is not; both print JSON to stdout.
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(typeof status.running, 'boolean');
}

// Under Bun, once anything materializes process.stdout (loading @inquirer/core
// does), a console.log over 64 KiB to a pipe keeps only the first 65536 bytes.
// Only the compiled bundle shows whether an import got hoisted into the entry.
function checkPipedListings() {
  const agentsHome = join(root, 'agents');
  for (let t = 0; t < 30; t++) {
    const dir = join(agentsHome, 'browser', 'cache', 'fixture', 'sessions', `task-${t}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `screenshot-${t}-${i}.png`), 'x');
  }
  const listingEnv = { ...env, AGENTS_HOME: agentsHome };
  for (const args of [['sessions', '--json'], ['sessions', '--tasks', '--json']]) {
    const piped = spawnSync(binary, args, { cwd: root, env: listingEnv, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(piped.status, 0, String(piped.stderr));
    const file = join(root, 'listing.json');
    const fd = openSync(file, 'w');
    let redirected;
    try {
      redirected = spawnSync(binary, args, { cwd: root, env: listingEnv, timeout: 15000, stdio: ['ignore', fd, 'pipe'] });
    } finally {
      closeSync(fd);
    }
    assert.equal(redirected.status, 0, String(redirected.stderr));
    const expected = readFileSync(file);
    assert.ok(expected.length > 100_000, `browser ${args.join(' ')} wrote only ${expected.length} bytes to a file`);
    assert.equal(piped.stdout.length, expected.length, `browser ${args.join(' ')}: ${piped.stdout.length} bytes piped, ${expected.length} redirected`);
    JSON.parse(piped.stdout.toString('utf8'));
  }
  return listingEnv;
}

// The picker loads @inquirer/core on first use; the final compile must have
// bundled it. Node has no PTY, so python3's pty drives the binary; Windows has
// neither, so the check runs on Linux and macOS.
const PTY_DRIVER = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], 'sessions'])
out, end = b'', time.time() + 10
while time.time() < end and b'browse captures' not in out:
    if select.select([fd], [], [], 0.1)[0]:
        try: out += os.read(fd, 65536)
        except OSError: break
os.kill(pid, 9)
sys.stdout.write(out.decode('utf8', 'replace'))
`;

function checkInteractivePicker(listingEnv) {
  if (process.platform === 'win32') return 'skipped on Windows (no PTY)';
  const driven = spawnSync('python3', ['-c', PTY_DRIVER, binary], { cwd: root, env: listingEnv, encoding: 'utf8', timeout: 20000 });
  assert.equal(driven.status, 0, driven.stderr);
  assert.match(driven.stdout, /Browser history:[\s\S]*task-\d+[\s\S]*browse captures/, driven.stdout);
  return 'passed';
}

try {
  const identified = run(['--version']);
  assert.equal(identified.status, 0, identified.stderr);
  assert.equal(identified.stdout.trim(), version);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /status/);
  checkStatus(run(['status', '--json'], '{"version":1,"target":{"host":"user@box"}}'));
  for (const [context, error] of [['{', /context is not valid JSON/], ['{"version":999}', /unsupported browser context version/]]) {
    const rejected = run(['status', '--json'], context);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, error);
    assert.equal(rejected.stdout, '');
  }
  writeFileSync(join(root, '.env'), 'BROWSER_CONTEXT_FD=0\n');
  writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./must-not-load.js"]\n');
  checkStatus(run(['status', '--json']));
  const picker = checkInteractivePicker(checkPipedListings());
  console.log(`Compiled ${version}: version, help, inherited context, malformed context rejection, disabled environment/config autoload, and piped listings over 100 KB passed; interactive picker ${picker}`);
} finally {
  rmSync(root, { recursive: true });
}
