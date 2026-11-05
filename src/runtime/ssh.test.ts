import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFromHost, copyToHost } from './remote.js';
import { controlDir, controlOpts, sshExec } from './ssh.js';

const SSHD = '/usr/sbin/sshd';
const haveSshd =
  process.platform !== 'win32' &&
  fs.existsSync(SSHD) &&
  spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

/**
 * A real sshd for this user, spoken to over `ProxyCommand=sshd -i`: no port,
 * no root, no network. The identity args play the part of a host's `sshArgs`.
 */
function startSshd(dir: string): string[] {
  for (const key of ['hostkey', 'userkey']) {
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, key)], { stdio: 'ignore' });
  }
  fs.copyFileSync(path.join(dir, 'userkey.pub'), path.join(dir, 'authorized_keys'));
  fs.chmodSync(path.join(dir, 'authorized_keys'), 0o600);
  const config = path.join(dir, 'sshd_config');
  fs.writeFileSync(
    config,
    [
      `HostKey ${path.join(dir, 'hostkey')}`,
      `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
      'StrictModes no',
      'UsePAM no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PidFile none',
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n'),
  );
  return [
    '-F', '/dev/null',
    '-i', path.join(dir, 'userkey'),
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', `ProxyCommand=${SSHD} -i -f ${config}`,
  ];
}

describe.skipIf(!haveSshd)('ssh multiplexing under a long AGENTS_HOME', () => {
  let root: string;
  let identity: string[];
  const savedHome = process.env.AGENTS_HOME;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mux-'));
    identity = startSshd(root);
    process.env.AGENTS_HOME = path.join(root, 'home-'.padEnd(120, 'x'));
  });

  afterEach(() => {
    const opts = controlOpts();
    if (opts.length > 0) spawnSync('ssh', [...opts, ...identity, '-O', 'exit', 'fake-host'], { stdio: 'ignore' });
    const dir = controlDir();
    if (dir && !dir.startsWith(root)) fs.rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a verb and its screenshot copy work without a master when the home is too long', () => {
    const first = sshExec('fake-host', 'echo ok', { extraSshArgs: identity, timeoutMs: 15_000 });
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout.trim()).toBe('ok');

    expect(controlOpts()).toEqual([]);

    const remote = path.join(root, 'shot.png');
    fs.writeFileSync(remote, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    const local = path.join(root, 'copied.png');
    const copied = copyFromHost({ host: 'fake-host', sshArgs: identity }, remote, local);
    expect(copied.stderr).toBe('');
    expect(copied.status).toBe(0);
    expect(fs.readFileSync(local)).toEqual(fs.readFileSync(remote));
  });

  test('a file `show` sends to the hub arrives intact', () => {
    const local = path.join(root, 'report.html');
    fs.writeFileSync(local, '<!doctype html><title>r</title>');
    const remote = path.join(root, 'My Reports $(x)', 'pushed.html');
    fs.mkdirSync(path.dirname(remote));
    const copied = copyToHost({ host: 'fake-host', sshArgs: identity }, local, remote);
    expect(copied.stderr).toBe('');
    expect(copied.status).toBe(0);
    expect(fs.readFileSync(remote, 'utf8')).toBe('<!doctype html><title>r</title>');
  });
});

describe.skipIf(process.platform === 'win32')('controlDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync('/tmp/ssh-dir-');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('keeps the cache directory when its socket paths fit', () => {
    const cache = path.join(root, '.cache');
    expect(controlDir(cache)).toBe(path.join(cache, 'ssh'));
  });

  test('does not write a socket directory outside a long home', () => {
    const cache = path.join(root, 'home-'.padEnd(120, 'x'));
    expect(controlDir(cache)).toBeNull();
    expect(fs.existsSync(cache)).toBe(false);
  });
});
