import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { Command, Option } from 'commander';
import { resolveHostTarget, tunnelEndpoint, type HostTarget } from './hosts.js';
import { machineId, normalizeHost } from './machine-id.js';
import { SSH_OPTS, assertValidSshTarget, controlOpts, shellQuote, sshExec, type SshExecResult } from './ssh.js';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * True when `name` is THIS machine (short hostname via {@link machineId}, or loopback),
 * so a route naming the local box runs locally instead of SSHing to itself.
 */
export function isSelfHost(name?: string | null): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (n.length === 0) return false;
  if (LOOPBACK.includes(n)) return true;
  return normalizeHost(n) === machineId();
}

/**
 * The whole resolved target, so the user, platform and identity `sshArgs` an
 * inherited context carries reach every transport below.
 */
export async function resolveHost(name: string): Promise<HostTarget | null> {
  try {
    return resolveHostTarget({ device: name });
  } catch {
    return null;
  }
}

export function sshTargetFor(target: HostTarget): string {
  const { user, host } = tunnelEndpoint(target);
  const destination = user ? `${user}@${host}` : host;
  assertValidSshTarget(destination);
  return destination;
}

/**
 * The one remote command line for a forwarded verb. Every word is POSIX-quoted, so
 * `$(id)` arrives as text; caller identity and the remote-control marker go as `env`.
 */
export function buildRemoteBrowserCommand(argv: string[], env: Record<string, string>): string {
  const words = argv[0] === 'browser' ? argv.slice(1) : argv;
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment name: ${key}`);
    return shellQuote(`${key}=${value}`);
  });
  return ['env', ...assignments, 'browser', ...words.map(shellQuote)].join(' ');
}

/** Run a remote command over ssh with the terminal attached; returns its exit code. */
export function streamOnHost(target: HostTarget, remoteCmd: string, interactive: boolean): number {
  const destination = sshTargetFor(target);
  const result = spawnSync(
    'ssh',
    [...SSH_OPTS, ...controlOpts(), ...(target.sshArgs ?? []), interactive ? '-t' : '-T', destination, remoteCmd],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

/** Run a remote command over ssh and capture its output. */
export function captureOnHost(target: HostTarget, remoteCmd: string): SshExecResult {
  return sshExec(sshTargetFor(target), remoteCmd, { extraSshArgs: target.sshArgs });
}

/**
 * scp reads `-p` as preserve-times and `-l` as a bandwidth limit, so those ssh flags are
 * rewritten in split (`-p 22`) and attached (`-p22`) forms; other identity flags match.
 */
export function scpArgsFromSsh(sshArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sshArgs.length; i++) {
    const arg = sshArgs[i];
    if (arg === '-p' && i + 1 < sshArgs.length) out.push('-P', sshArgs[++i]);
    else if (arg === '-l' && i + 1 < sshArgs.length) out.push('-o', `User=${sshArgs[++i]}`);
    else if (arg.startsWith('-p') && arg.length > 2) out.push(`-P${arg.slice(2)}`);
    else if (arg.startsWith('-l') && arg.length > 2) out.push(`-oUser=${arg.slice(2)}`);
    else out.push(arg);
  }
  return out;
}

function scp(target: HostTarget, from: string, to: string, flags: string[] = []): SpawnSyncReturns<string> {
  return spawnSync(
    'scp',
    [...flags, ...SSH_OPTS, ...controlOpts(), ...scpArgsFromSsh(target.sshArgs ?? []), from, to],
    { encoding: 'utf8' },
  );
}

/** Over the master connection the verb that made the file just used. */
export function copyFromHost(target: HostTarget, remotePath: string, localPath: string): SpawnSyncReturns<string> {
  return scp(target, `${sshTargetFor(target)}:${remotePath}`, localPath);
}

export function copyToHost(target: HostTarget, localPath: string, remotePath: string): SpawnSyncReturns<string> {
  return scp(target, localPath, `${sshTargetFor(target)}:${remotePath}`, ['-s']);
}

/**
 * `argv` without the `drop` options, parsed by Commander's grammar for what `command` and its
 * ancestors declare. `insert` lands before `--` so it still reads as options.
 */
export function forwardedCommandArgv(argv: string[], command: Command, drop: string[], insert: string[] = []): string[] {
  const options: Option[] = [];
  for (let c: Command | null = command; c; c = c.parent) options.push(...c.options);
  const find = (flag: string) => options.find((o) => o.short === flag || o.long === flag);
  const maybeOption = (word: string) => word.length > 1 && word[0] === '-';
  const path: string[][] = [];
  for (let c: Command | null = command; c; c = c.parent) path.unshift([c.name(), ...c.aliases()]);
  let pathIndex = 0;
  let argIndex = 0;
  const out: string[] = [];
  const pending = [...argv];
  let variadic: Option | undefined;
  while (pending.length > 0) {
    const word = pending.shift()!;
    if (word === '--') return [...out, ...insert, word, ...pending];
    if (variadic && !maybeOption(word)) {
      if (!drop.includes(variadic.name())) out.push(word);
      continue;
    }
    variadic = undefined;
    const words = [word];
    let option = maybeOption(word) ? find(word) : undefined;
    if (option?.required && pending.length > 0) words.push(pending.shift()!);
    else if (option?.optional && pending.length > 0 && !maybeOption(pending[0])) words.push(pending.shift()!);
    if (option?.variadic) variadic = option;
    if (!option && word.length > 2 && word[0] === '-' && word[1] !== '-') {
      option = find(`-${word[1]}`);
      if (option && !option.required && !option.optional) {
        words[0] = word.slice(0, 2);
        pending.unshift(`-${word.slice(2)}`);
      }
    }
    if (!option && /^--[^=]+=/.test(word)) {
      const long = find(word.slice(0, word.indexOf('=')));
      if (long && (long.required || long.optional)) option = long;
    }
    if (!option && !maybeOption(word)) {
      const level = path.findIndex((names, i) => i >= pathIndex && names.includes(word));
      if (argIndex === 0 && level >= 0) {
        pathIndex = level + 1;
        out.push(word);
        continue;
      }
      const argument = command.registeredArguments[Math.min(argIndex, command.registeredArguments.length - 1)];
      const isArgument = argIndex < command.registeredArguments.length || argument?.variadic;
      argIndex++;
      if (!(isArgument && argument && drop.includes(argument.name()))) out.push(word);
      continue;
    }
    if (!option || !drop.includes(option.name())) out.push(...words);
  }
  return [...out, ...insert];
}
