import { loadContext } from './context.js';

/**
 * An inherited context session owns the whole identity, so its actor (or `user`)
 * wins; the ambient `AGENTS_ACTOR` applies only when no context session exists.
 */
export function resolveActor(env: NodeJS.ProcessEnv = process.env): { id: string } {
  let session: { actor?: string } | undefined;
  try {
    session = loadContext(env)?.session;
  } catch { /* standalone */ }
  if (session) return { id: session.actor || 'user' };
  return { id: env.AGENTS_ACTOR || 'user' };
}
