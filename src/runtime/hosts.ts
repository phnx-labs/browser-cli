/**
 * Turn what the user typed into an SSH target. `--host` wins; a `--device` alias resolves via
 * inherited context (`devices`, then `target`), `~/.ssh/config`, then verbatim as ssh would.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertValidSshTarget } from './ssh.js';
import { resolveContextDevice, type HostTarget } from './context.js';

export type { HostTarget };

/** What every remote-capable subcommand accepts. */
export interface HostSelector {
  host?: string;
  device?: string;
  sshArg?: string[];
  /** Asserted platform, when the caller knows it (`--platform windows`). */
  platform?: string;
}

/**
 * Whether `~/.ssh/config` declares this alias, and its `User`. A deliberately shallow
 * parse: ssh itself applies the full config when invoked.
 */
export function probeHost(_target: string): { reachable: boolean; os?: string } {
  return { reachable: true, os: 'posix' };
}

export function sshConfigHost(alias: string, configPath = path.join(os.homedir(), '.ssh', 'config')): { user?: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  let inBlock = false;
  let user: string | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const hostMatch = line.match(/^Host\s+(.+)$/i);
    if (hostMatch) {
      if (inBlock) break; // the alias's block ended
      inBlock = hostMatch[1].split(/\s+/).includes(alias);
      continue;
    }
    if (!inBlock) continue;
    const userMatch = line.match(/^User\s+(\S+)$/i);
    if (userMatch) user = userMatch[1];
  }
  return inBlock || user ? { user } : null;
}

/**
 * Resolve a selector to a target, or throw with what was missing. `sshArgs` put the
 * caller's `--ssh-arg` flags after the parent's, so an explicit flag overrides.
 */
export function resolveHostTarget(sel: HostSelector, env: NodeJS.ProcessEnv = process.env): HostTarget {
  const extra = sel.sshArg ?? [];

  if (sel.host) {
    assertValidSshTarget(sel.host);
    const fromContext = resolveContextDevice(sel.host, env);
    return {
      alias: fromContext?.alias,
      host: sel.host,
      user: sel.host.includes('@') ? sel.host.split('@')[0] : fromContext?.user,
      hostname: sel.host.includes('@') ? sel.host.split('@')[1] : sel.host,
      platform: sel.platform ?? fromContext?.platform,
      sshArgs: [...(fromContext?.sshArgs ?? []), ...extra],
    };
  }

  if (!sel.device) {
    throw new Error('no remote target. Pass --host <user@host> (or --device <alias> when a context or ~/.ssh/config entry names it).');
  }

  const fromContext = resolveContextDevice(sel.device, env);
  if (fromContext) {
    assertValidSshTarget(fromContext.host);
    return {
      ...fromContext,
      platform: sel.platform ?? fromContext.platform,
      sshArgs: [...(fromContext.sshArgs ?? []), ...extra],
    };
  }

  assertValidSshTarget(sel.device);
  const fromSshConfig = sshConfigHost(sel.device);
  return {
    alias: sel.device,
    host: sel.device,
    user: fromSshConfig?.user,
    hostname: sel.device,
    platform: sel.platform,
    sshArgs: extra,
  };
}

/**
 * The user/host pair `ssh -L` needs. A bare alias has no user of its own —
 * OpenSSH must resolve it from its own config, without a user override.
 */
export function tunnelEndpoint(target: HostTarget): { user: string; host: string } {
  if (target.host.includes('@')) {
    const [user, host] = target.host.split('@');
    return { user, host };
  }
  return { user: target.user || '', host: target.host };
}
