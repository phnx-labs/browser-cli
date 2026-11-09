import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { buildRemoteBrowserCommand, forwardedCommandArgv, isSelfHost, scpArgsFromSsh } from './remote.js';

/**
 * The remote side runs this string through a POSIX shell, so run it through a real
 * `sh` with a stand-in `browser` on PATH that records the argv it received.
 */
describe.skipIf(process.platform === 'win32')('buildRemoteBrowserCommand', () => {
  test('delivers every argument literally and sets the env marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-cmd-'));
    const canary = path.join(dir, 'pwned');
    fs.writeFileSync(
      path.join(dir, 'browser'),
      '#!/bin/sh\nprintf "%s\\n" "marker=$AGENTS_FLEET_REMOTE" "$@"\n',
      { mode: 0o755 },
    );
    const hostile = [`$(touch ${canary})`, '`touch ' + canary + '`', "it's", 'a b', '$HOME'];
    const cmd = buildRemoteBrowserCommand(['browser', 'click', ...hostile], { AGENTS_FLEET_REMOTE: '1' });

    const run = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin` } });

    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual(['marker=1', 'click', ...hostile]);
    expect(fs.existsSync(canary)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects an environment name the shell would not treat as an assignment', () => {
    expect(() => buildRemoteBrowserCommand(['navigate'], { 'A;id': 'x' })).toThrow(/Invalid environment name/);
  });
});

// machineId() reads AGENTS_SYNC_MACHINE_ID before os.hostname(), so pin it to
// keep the expectations independent of the box the suite runs on.
describe('isSelfHost', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'box-a';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prev;
  });

  test('matches this machine so a self route runs locally instead of self-SSHing', () => {
    expect(isSelfHost('box-a')).toBe(true);
    expect(isSelfHost('BOX-A')).toBe(true);
    expect(isSelfHost('box-a.')).toBe(true);
    expect(isSelfHost('box-a.tailnet-example.ts.net')).toBe(true);
  });

  test('matches loopback names', () => {
    expect(isSelfHost('localhost')).toBe(true);
    expect(isSelfHost('127.0.0.1')).toBe(true);
    expect(isSelfHost('::1')).toBe(true);
  });

  test('rejects other hosts and empty input', () => {
    expect(isSelfHost('laptop')).toBe(false);
    expect(isSelfHost('box-b')).toBe(false);
    expect(isSelfHost('')).toBe(false);
    expect(isSelfHost(undefined)).toBe(false);
    expect(isSelfHost(null)).toBe(false);
  });
});

describe('forwardedCommandArgv', () => {
  const program = new Command('browser').option('-v, --version');
  const type = program.command('type <ref>').option('--task <name>').option('--device <name>').option('--text <text>');
  const shot = program.command('screenshot').option('--device <name>').option('-o, --output <path>').option('-f, --full');

  test('reads a value that looks like a routing flag as the value it is', () => {
    expect(forwardedCommandArgv(['type', '1', '--text', '--device=x', '--device', 'hub'], type, ['device']))
      .toEqual(['type', '1', '--text', '--device=x']);
    expect(forwardedCommandArgv(['type', '1', '--text=--device', '--device=hub'], type, ['device']))
      .toEqual(['type', '1', '--text=--device']);
  });

  test('drops an attached or grouped short value and keeps its neighbours', () => {
    expect(forwardedCommandArgv(['screenshot', '-o/tmp/a.png', '--device', 'hub'], shot, ['device', 'output']))
      .toEqual(['screenshot']);
    expect(forwardedCommandArgv(['screenshot', '-fo', '/tmp/a.png'], shot, ['output'])).toEqual(['screenshot', '-f']);
  });

  test('drops a positional argument by name and keeps the command words and option values', () => {
    const pdf = program.command('pdf [output]').option('--task <name>').option('--device <name>');
    expect(forwardedCommandArgv(['browser', 'pdf', 'out.pdf', '--device', 'hub'], pdf, ['device', 'output']))
      .toEqual(['browser', 'pdf']);
    expect(forwardedCommandArgv(['pdf', '--task', 'out.pdf', 'out.pdf'], pdf, ['output'])).toEqual(['pdf', '--task', 'out.pdf']);
    expect(forwardedCommandArgv(['pdf', 'pdf', '--task', 't'], pdf, ['output'])).toEqual(['pdf', '--task', 't']);
    expect(forwardedCommandArgv(['pdf', 'keep.pdf'], pdf, ['device'])).toEqual(['pdf', 'keep.pdf']);
  });

  test('leaves everything after -- literal and inserts before it', () => {
    expect(forwardedCommandArgv(['type', '1', '--', '--device', 'x'], type, ['device'], ['--task', 't']))
      .toEqual(['type', '1', '--task', 't', '--', '--device', 'x']);
    expect(forwardedCommandArgv(['type', '1', '--text', '--', '--device', 'hub'], type, ['device'], ['--task', 't']))
      .toEqual(['type', '1', '--text', '--', '--task', 't']);
  });
});

describe('scpArgsFromSsh', () => {
  test('rewrites split and attached port and user flags word for word', () => {
    expect(scpArgsFromSsh(['-p', '2222', '-l', 'me', '-i', 'key'])).toEqual(['-P', '2222', '-o', 'User=me', '-i', 'key']);
    expect(scpArgsFromSsh(['-p2222', '-lme', '-oIdentitiesOnly=yes'])).toEqual(['-P2222', '-oUser=me', '-oIdentitiesOnly=yes']);
  });
});
