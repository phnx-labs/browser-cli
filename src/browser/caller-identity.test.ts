import { describe, it, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { taskMatchesCaller, resolveCallerIdentity, callerIdentityEnv } from './caller-identity.js';
import { stampCallerIdentity } from './ipc.js';
import { resolveTaskIdentity } from './service.js';
import type { IPCRequest } from './types.js';
import { CONTEXT_FD_ENV, resetContextCache } from '../runtime/context.js';

describe('callerIdentityEnv', () => {
  it('forwards both ids when present so the hub resolves the caller', () => {
    expect(callerIdentityEnv({ actor: 'claude', sessionId: 'sess-a', launchId: 'launch-1' })).toEqual({
      AGENTS_ACTOR: 'claude',
      AGENT_SESSION_ID: 'sess-a',
      AGENT_LAUNCH_ID: 'launch-1',
    });
  });

  it('forwards only the ids it has', () => {
    expect(callerIdentityEnv({ actor: 'codex', launchId: 'launch-2' })).toEqual({
      AGENTS_ACTOR: 'codex',
      AGENT_LAUNCH_ID: 'launch-2',
    });
  });

  it('forwards no ids for an unidentifiable caller — never an empty string that reads as a real blank identity', () => {
    expect(callerIdentityEnv({ actor: 'user' })).toEqual({ AGENTS_ACTOR: 'user' });
  });

  it('round-trips: the hub resolves the identity the caller forwarded', () => {
    const caller = resolveCallerIdentity({ CODEX_THREAD_ID: 'thread-1', AGENT_LAUNCH_ID: 'launch-1', AGENTS_ACTOR: 'codex' });
    expect(resolveCallerIdentity(callerIdentityEnv(caller))).toEqual(caller);
  });
});

describe('taskMatchesCaller', () => {
  it('matches on sessionId', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-a' },
      ),
    ).toBe(true);
  });

  it('matches on launchId when session differs', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { launchId: 'launch-1' },
      ),
    ).toBe(true);
  });

  it('does not match when neither identity overlaps', () => {
    expect(
      taskMatchesCaller(
        { sessionId: 'sess-a', launchId: 'launch-1' },
        { sessionId: 'sess-b', launchId: 'launch-2' },
      ),
    ).toBe(false);
  });

  it('does not match an empty caller against a stamped task', () => {
    expect(
      taskMatchesCaller({ sessionId: 'sess-a' }, {}),
    ).toBe(false);
  });
});

describe('resolveCallerIdentity', () => {
  const dirs: string[] = [];
  const fds: number[] = [];
  afterEach(() => {
    resetContextCache();
    for (const fd of fds.splice(0)) fs.closeSync(fd);
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function contextEnv(contents: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-caller-'));
    dirs.push(dir);
    const file = path.join(dir, 'context.json');
    fs.writeFileSync(file, contents);
    const fd = fs.openSync(file, 'r');
    fds.push(fd);
    return { [CONTEXT_FD_ENV]: String(fd), ...extra };
  }

  it('reads Agents-managed ids and actor from the env', () => {
    expect(resolveCallerIdentity({
      AGENT_SESSION_ID: 'env-session-1',
      AGENT_LAUNCH_ID: 'env-launch-1',
      AGENTS_ACTOR: 'claude',
    })).toEqual({ actor: 'claude', sessionId: 'env-session-1', launchId: 'env-launch-1' });
    expect(resolveCallerIdentity({ AGENTS_SESSION_ID: 'plural-session' }).sessionId).toBe('plural-session');
  });

  it('identifies a native harness session that no launcher stamped', () => {
    expect(resolveCallerIdentity({ CODEX_THREAD_ID: 'thread-1' })).toEqual({ actor: 'user', sessionId: 'thread-1' });
    expect(resolveCallerIdentity({ CLAUDE_CODE_SESSION_ID: 'claude-1' }).sessionId).toBe('claude-1');
    expect(resolveCallerIdentity({ CLAUDE_SESSION_ID: 'claude-2' }).sessionId).toBe('claude-2');
    expect(resolveCallerIdentity({ AGENTS_RUN_ID: 'run-1' }).sessionId).toBe('run-1');
  });

  it('prefers the harness session over the Agents one, as the Agents launcher does', () => {
    expect(resolveCallerIdentity({ CODEX_THREAD_ID: 'thread-1', AGENT_SESSION_ID: 'agent-1' }).sessionId).toBe('thread-1');
  });

  it('gives an unidentified caller the generic actor and no ids', () => {
    expect(resolveCallerIdentity({})).toEqual({ actor: 'user' });
  });

  it('takes the inherited context session whole, ignoring a different caller in the env', () => {
    const env = contextEnv(
      JSON.stringify({ version: 1, session: { sessionId: 'ctx-session', launchId: 'ctx-launch', actor: 'ctx-actor' } }),
      { CODEX_THREAD_ID: 'other-thread', AGENT_LAUNCH_ID: 'other-launch', AGENTS_ACTOR: 'other-actor' },
    );
    expect(resolveCallerIdentity(env)).toEqual({ actor: 'ctx-actor', sessionId: 'ctx-session', launchId: 'ctx-launch' });
  });

  it('does not mix env ids into a context session that has none', () => {
    const env = contextEnv(JSON.stringify({ version: 1, session: { actor: 'user' } }), { CODEX_THREAD_ID: 'thread-1' });
    expect(resolveCallerIdentity(env)).toEqual({ actor: 'user' });
  });

  it('gives a context session without an actor the generic actor, never the ambient one', () => {
    const env = contextEnv(
      JSON.stringify({ version: 1, session: { sessionId: 'ctx-only' } }),
      { AGENTS_ACTOR: 'foreign-actor' },
    );
    expect(resolveCallerIdentity(env)).toEqual({ actor: 'user', sessionId: 'ctx-only' });
  });

  it('gives an empty context session or empty actor the generic actor, never the ambient one', () => {
    expect(resolveCallerIdentity(contextEnv(
      JSON.stringify({ version: 1, session: {} }),
      { AGENTS_ACTOR: 'foreign-actor', AGENT_SESSION_ID: 'foreign-session' },
    ))).toEqual({ actor: 'user' });
    resetContextCache();
    expect(resolveCallerIdentity(contextEnv(
      JSON.stringify({ version: 1, session: { sessionId: 'ctx-only', actor: '' } }),
      { AGENTS_ACTOR: 'foreign-actor' },
    ))).toEqual({ actor: 'user', sessionId: 'ctx-only' });
  });

  it('forwards and stamps the context identity, not the ambient actor, all the way to the task owner', () => {
    const env = contextEnv(
      JSON.stringify({ version: 1, session: { sessionId: 'ctx-only' } }),
      { AGENTS_ACTOR: 'foreign-actor' },
    );
    const caller = resolveCallerIdentity(env);
    // `--device`: the hub resolves exactly what the worker would have stamped.
    expect(callerIdentityEnv(caller)).toEqual({ AGENTS_ACTOR: 'user', AGENT_SESSION_ID: 'ctx-only' });
    expect(resolveCallerIdentity(callerIdentityEnv(caller))).toEqual(caller);
    // Local IPC: the request carries it and the daemon records it as the history owner.
    const stamped = stampCallerIdentity({ action: 'navigate' } as IPCRequest, env);
    expect(stamped).toMatchObject({ actor: 'user', sessionId: 'ctx-only' });
    expect(resolveTaskIdentity(stamped, () => 'daemon-actor')).toEqual({ owner: 'user', sessionId: 'ctx-only', launchId: undefined });
  });

  it('keeps an explicit per-request identity over the context session', () => {
    const env = contextEnv(JSON.stringify({ version: 1, session: { sessionId: 'ctx-only', actor: 'ctx-actor' } }));
    expect(stampCallerIdentity(
      { action: 'navigate', actor: 'request-actor', sessionId: 'request-session' } as IPCRequest,
      env,
    )).toMatchObject({ actor: 'request-actor', sessionId: 'request-session' });
  });

  it('falls back to the env, ambient actor included, when the context carries no session', () => {
    const env = contextEnv(
      JSON.stringify({ version: 1, target: { host: 'laptop' } }),
      { CODEX_THREAD_ID: 'thread-1', AGENTS_ACTOR: 'codex' },
    );
    expect(resolveCallerIdentity(env)).toEqual({ actor: 'codex', sessionId: 'thread-1' });
  });

  it('fails on a malformed context instead of resolving a different caller', () => {
    expect(() => resolveCallerIdentity(contextEnv('{nope', { CODEX_THREAD_ID: 'thread-1' }))).toThrow(/not valid JSON/);
    resetContextCache();
    expect(() => resolveCallerIdentity(contextEnv('{"version":1,"session":{"sessionId":7}}'))).toThrow(/context session/);
  });
});
