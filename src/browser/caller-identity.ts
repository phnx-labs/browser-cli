/**
 * Who ran `browser`, captured in the CLI and forwarded to the shared daemon. One source wins
 * whole: the inherited `BROWSER_CONTEXT_FD` session, else the environment, else the generic `user`.
 */
import { loadContext } from '../runtime/context.js';
import { resolveActor } from '../runtime/actor.js';

export interface CallerIdentity {
  actor: string;
  launchId?: string;
  sessionId?: string;
}

function envSessionId(env: NodeJS.ProcessEnv): string | undefined {
  return env.CODEX_THREAD_ID
    || env.CLAUDE_CODE_SESSION_ID
    || env.CLAUDE_SESSION_ID
    || env.AGENTS_SESSION_ID
    || env.AGENT_SESSION_ID
    || env.AGENTS_RUN_ID
    || undefined;
}

export function resolveCallerIdentity(env: NodeJS.ProcessEnv = process.env): CallerIdentity {
  const session = loadContext(env)?.session;
  const sessionId = session ? session.sessionId : envSessionId(env);
  const launchId = session ? session.launchId : env.AGENT_LAUNCH_ID;
  return {
    actor: resolveActor(env).id,
    ...(sessionId ? { sessionId } : {}),
    ...(launchId ? { launchId } : {}),
  };
}

/**
 * The identity env a `--device` dispatch forwards so the hub stamps the same caller; a blank one
 * would match any no-identity task and could close another's browser. Absent ids are omitted.
 */
export function callerIdentityEnv(caller: CallerIdentity): Record<string, string> {
  const env: Record<string, string> = { AGENTS_ACTOR: caller.actor };
  if (caller.sessionId) env.AGENT_SESSION_ID = caller.sessionId;
  if (caller.launchId) env.AGENT_LAUNCH_ID = caller.launchId;
  return env;
}

/**
 * True when a live task belongs to this caller by sessionId or launchId. A task with no recorded
 * identity never matches a caller that has one.
 */
export function taskMatchesCaller(
  task: { sessionId?: string; launchId?: string },
  caller: { sessionId?: string; launchId?: string },
): boolean {
  if (caller.sessionId && task.sessionId && caller.sessionId === task.sessionId) return true;
  if (caller.launchId && task.launchId && caller.launchId === task.launchId) return true;
  return false;
}
