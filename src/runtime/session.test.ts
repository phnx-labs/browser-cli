import { describe, it, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isSessionIdLiveOnProcessTable } from './session.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const supported = process.platform === 'darwin' || process.platform === 'linux';

/**
 * The reaper closes a task on `false`, so against the real process table a live
 * session must read live and only a session no process names may read dead.
 */
describe.skipIf(!supported)('isSessionIdLiveOnProcessTable', () => {
  it('sees a session id in a live process environment, and not after it exits', async () => {
    const id = randomUUID();
    // A node process, as agent CLIs are: macOS hides the environment of platform binaries like /bin/sleep.
    const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { env: { ...process.env, AGENT_SESSION_ID: id }, stdio: 'ignore' });
    try {
      await sleep(200);
      expect(isSessionIdLiveOnProcessTable(id)).toBe(true);
    } finally {
      child.kill();
    }
    await sleep(2_200); // past the per-pass cache
    expect(isSessionIdLiveOnProcessTable(id)).toBe(false);
  });

  it('sees a session id on a live process argv', async () => {
    const id = randomUUID();
    const child = spawn('sh', ['-c', 'sleep 30; true', 'claude', '--session-id', id], { stdio: 'ignore' });
    try {
      await sleep(2_200);
      expect(isSessionIdLiveOnProcessTable(id)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
