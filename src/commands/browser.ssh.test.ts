import { afterAll, beforeAll, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

// Inherited SSH arguments are the only route to the disposable hub; dropping them must fail instead of
// reaching another sshd.
const sshd = '/usr/sbin/sshd';
const chrome = process.env.AGENTS_TEST_CHROME;
const ready = process.platform !== 'win32' && fs.existsSync(sshd) && !!chrome;

let root: string;
let callerHome: string;
let hubHome: string;
let contextFile: string;
let sshdPid: number | undefined;
const entry = path.join(import.meta.dir, '..', 'index.ts');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function baseEnv(home: string, machine: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTS_') && !key.startsWith('BROWSER_')),
  ) as Record<string, string>;
  return { ...env, HOME: home, AGENTS_HOME: home, AGENTS_SYNC_MACHINE_ID: machine };
}

/** Run the caller-side CLI with the context on fd 3. */
function caller(args: string[], env: Record<string, string> = {}, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const contextFd = fs.openSync(contextFile, 'r');
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...baseEnv(callerHome, 'caller-host'), BROWSER_CONTEXT_FD: '3', ...env },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', contextFd],
  });
  fs.closeSync(contextFd);
  if (input !== undefined) child.stdin!.end(input);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  child.stderr!.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function hub(args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], { env: baseEnv(hubHome, 'fixture-hub'), encoding: 'utf8' });
}

function setHubConsent(allowed: boolean): void {
  const file = path.join(hubHome, 'devices', 'fixture-hub', 'agents.yaml');
  const doc = yaml.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, yaml.stringify({ ...doc, config: { ...doc.config, browserRemoteControl: allowed, defaultBrowserProfile: 'fixture' } }));
}

function callerBinding(task: string): unknown {
  const found = spawnSync('find', [callerHome, '-name', 'task-index.json'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  for (const file of found) {
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = index.tasks ?? index;
    if (tasks[task]) return tasks[task];
  }
  return undefined;
}

beforeAll(async () => {
  if (!ready) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ssh-'));
  callerHome = path.join(root, 'caller');
  hubHome = path.join(root, 'hub');
  const bin = path.join(root, 'bin');
  for (const dir of [callerHome, hubHome, bin]) fs.mkdirSync(dir);
  for (const key of ['host_key', 'client_key']) {
    expect(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, key)]).status).toBe(0);
  }
  fs.copyFileSync(path.join(root, 'client_key.pub'), path.join(root, 'authorized_keys'));
  // The hub's `browser` is this same source tree, so both ends are the real CLI.
  fs.writeFileSync(path.join(bin, 'browser'), `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`, { mode: 0o755 });

  const port = await freePort();
  fs.writeFileSync(path.join(root, 'sshd_config'), [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${path.join(root, 'host_key')}`,
    `AuthorizedKeysFile ${path.join(root, 'authorized_keys')}`,
    `PidFile ${path.join(root, 'sshd.pid')}`,
    'StrictModes no',
    'UsePAM no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'Subsystem sftp internal-sftp',
    `SetEnv PATH=${bin}:/usr/bin:/bin HOME=${hubHome} AGENTS_HOME=${hubHome} AGENTS_SYNC_MACHINE_ID=fixture-hub`,
    '',
  ].join('\n'));
  expect(spawnSync(sshd, ['-f', path.join(root, 'sshd_config'), '-E', path.join(root, 'sshd.log')]).status).toBe(0);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(root, 'sshd.pid')); i++) await Bun.sleep(100);
  sshdPid = Number(fs.readFileSync(path.join(root, 'sshd.pid'), 'utf8'));

  fs.writeFileSync(contextFile = path.join(root, 'context.json'), JSON.stringify({
    version: 1,
    target: {
      alias: 'fixture-hub',
      host: 'fixture-hub.invalid',
      platform: process.platform,
      sshArgs: [
        '-F', '/dev/null',
        '-o', 'HostName=127.0.0.1',
        `-p${port}`,
        `-l${os.userInfo().username}`,
        '-i', path.join(root, 'client_key'),
        '-o', 'IdentitiesOnly=yes',
        '-o', `UserKnownHostsFile=${path.join(root, 'known_hosts')}`,
      ],
    },
  }));

  expect(hub(['profiles', 'create', 'fixture', '--browser', 'chromium', '--binary', chrome!, '--headless']).status).toBe(0);
});

afterAll(() => {
  if (!ready) return;
  hub(['stop', '--service']);
  // ControlPersist would keep each multiplexed master alive past the test.
  const muxDir = path.join(callerHome, 'browser', 'run', 'ssh');
  for (const socket of fs.existsSync(muxDir) ? fs.readdirSync(muxDir) : []) {
    spawnSync('ssh', ['-o', `ControlPath=${path.join(muxDir, socket)}`, '-O', 'exit', 'fixture-hub.invalid']);
  }
  if (sshdPid) process.kill(sshdPid);
  fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(!ready)('dispatches, streams and copies captures over the context target', async () => {
  // Refused by the hub's default-deny consent: the failure status crosses the
  // capture transport and no binding is created for a task that never started.
  const refused = await caller(['start', '--device', 'fixture-hub', '--url', 'about:blank', '--json']);
  expect(refused.stderr).toContain('remote-control on');
  expect(refused.code).toBe(1);

  setHubConsent(true);
  const started = await caller(['start', '--device', 'fixture-hub', '--url', 'data:text/html,<title>ssh-ok</title>', '--no-skills', '--json']);
  expect(started.stderr).toContain('started on fixture-hub');
  expect(started.code).toBe(0);
  const task = JSON.parse(started.stdout).task as string;
  expect(callerBinding(task)).toMatchObject({ device: 'fixture-hub' });

  const title = await caller(['evaluate', 'document.title', '--task', task]);
  expect(title.code).toBe(0);
  expect(title.stdout).toContain('ssh-ok');
  // The far side has no stdin: a piped script must arrive as the expression.
  const piped = await caller(['evaluate', '--file', '-', '--task', task], {}, "document.title + '-piped'");
  expect(piped.code).toBe(0);
  expect(piped.stdout).toContain('ssh-ok-piped');

  // Well past one pipe buffer, into a pipe nobody reads for two seconds: the
  // streamed verb must block under backpressure, never truncate.
  const big = spawnSync('bash', [
    '-o', 'pipefail', '-c', 'exec 3<"$0"; "$@" | (sleep 2; tr -cd x | wc -c)',
    contextFile, process.execPath, entry, 'evaluate', "'x'.repeat(2000000)", '--task', task,
  ], { env: { ...baseEnv(callerHome, 'caller-host'), BROWSER_CONTEXT_FD: '3' }, encoding: 'utf8' });
  expect(big.status).toBe(0);
  expect(big.stdout.trim()).toBe('2000000');

  // An option value that looks like a routing flag is still that value, split
  // or joined, and so is everything after `--`, where a task the caller only
  // inherits is inserted ahead of the sentinel.
  expect((await caller(['navigate', '--task', task, 'data:text/html,<input>'])).code).toBe(0);
  expect((await caller(['type', '1', '--task', task, '--text', '--device=a'])).code).toBe(0);
  expect((await caller(['type', '1', '--task', task, '--text=--device'])).code).toBe(0);
  expect((await caller(['evaluate', '--task', task, "window.device = 3; document.querySelector('input').value"])).stdout)
    .toContain('--device=a--device');
  const literal = await caller(['evaluate', '--', '--device'], { AGENTS_BROWSER_TASK: task });
  expect(literal.stderr).toBe('');
  expect(literal.stdout.trim()).toBe('2');

  for (const [i, args] of [['-o', 'shot0.jpg'], ['--output=shot1.jpg'], ['-oshot2.jpg']].entries()) {
    const output = path.join(root, 'out', `shot${i}.jpg`);
    const shot = await caller(['screenshot', '--task', task, ...args.map((a) => a.replace(/shot\d\.jpg/, output))]);
    expect(shot.stderr).toBe('');
    expect(shot.code).toBe(0);
    expect(shot.stdout.trim()).toBe(output);
    // The hub's default capture is a JPEG, copied byte-for-byte by scp.
    expect(fs.readFileSync(output).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }

  // A close the hub refuses keeps the local binding so the task stays reachable.
  setHubConsent(false);
  const refusedDone = await caller(['done', '--task', task]);
  expect(refusedDone.code).toBe(1);
  expect(callerBinding(task)).toMatchObject({ device: 'fixture-hub' });

  setHubConsent(true);
  const done = await caller(['done', '--task', task]);
  expect(done.code).toBe(0);
  expect(callerBinding(task)).toBeUndefined();
}, 180_000);
