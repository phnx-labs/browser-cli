import { spawn, type ChildProcess } from 'node:child_process';
import { SSH_OPTS, assertValidSshTarget, backgroundSpawnOptions } from './ssh.js';

export interface StartTunnelOptions {
  extraSshArgs?: string[];
}

export function buildTunnelArgs(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  extraSshArgs: string[] = [],
): string[] {
  const target = user ? `${user}@${host}` : host;
  assertValidSshTarget(target);
  return [
    ...SSH_OPTS,
    ...extraSshArgs,
    '-N',
    '-L', `${localPort}:127.0.0.1:${remotePort}`,
    target,
  ];
}

export function startSSHTunnel(
  user: string,
  host: string,
  localPort: number,
  remotePort: number,
  opts: StartTunnelOptions = {},
): ChildProcess {
  const args = buildTunnelArgs(user, host, localPort, remotePort, opts.extraSshArgs);
  return spawn('ssh', args, {
    ...backgroundSpawnOptions(),
    stdio: 'ignore',
  });
}
