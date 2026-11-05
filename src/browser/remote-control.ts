// Consent gate for driving this machine's browser from another fleet machine: a drive
// carrying FLEET_REMOTE_ENV is refused unless the owner ran `browser remote-control on`.
// The authoritative check is in the daemon (resolveOrCreateTask, start, stopProfile), since
// page verbs launch or attach implicitly; assertRemoteControlAllowed is the CLI fast-fail.

import { getConfigValue } from '../runtime/device-config.js';

/** Env marker set on every forwarded `browser` invocation by `buildRemoteBrowserCommand`. */
export const FLEET_REMOTE_ENV = 'AGENTS_FLEET_REMOTE';

/** True when this process was dispatched to this machine by a fleet `--device` or `agents ssh … browser` run. */
export function isFleetRemoteInvocation(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FLEET_REMOTE_ENV] === '1';
}

/**
 * Whether this machine allows other fleet machines to drive its browser. Reads
 * the device-scope `browser.remote-control` config key. Unset = off (deny).
 */
export function remoteControlEnabled(): boolean {
  return getConfigValue('browser.remote-control').value === true;
}

/**
 * CLI-side gate: a fleet-remote invocation throws unless the owner opted in; local
 * invocations pass. `env` and `enabled` are injectable for tests.
 */
export function assertRemoteControlAllowed(opts?: {
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
}): void {
  const env = opts?.env ?? process.env;
  if (!isFleetRemoteInvocation(env)) return;
  const enabled = opts?.enabled ?? remoteControlEnabled();
  if (enabled) return;

  const who = env.AGENTS_ACTOR_HOST || env.AGENTS_ACTOR || 'A fleet machine';
  throw new Error(remoteControlRefusal(who));
}

/**
 * Daemon-side gate. Reads only the per-request marker and actor, never `process.env`: a
 * daemon auto-started by a fleet-remote CLI would otherwise refuse every local drive.
 */
export function assertRemoteControlAllowedForRequest(
  fleetRemote: boolean | undefined,
  opts: { actor?: string; enabled?: boolean } = {},
): void {
  if (!fleetRemote) return;
  const enabled = opts.enabled ?? remoteControlEnabled();
  if (enabled) return;
  throw new Error(remoteControlRefusal(opts.actor || 'A fleet machine'));
}

/** The refusal text, shared by the CLI-side and daemon-side gates. */
export function remoteControlRefusal(who: string): string {
  return (
    `${who} tried to drive this machine's browser from another machine, but remote ` +
    `browser control is off here. To allow it, run on THIS machine:\n` +
    `  browser remote-control on`
  );
}
