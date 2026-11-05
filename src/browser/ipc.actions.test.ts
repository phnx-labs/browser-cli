import { afterAll, beforeAll, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ipc-actions-'));
process.env.AGENTS_HOME = TEST_HOME;
process.env.AGENTS_HISTORY_DIR = path.join(TEST_HOME, '.history');

const { BrowserService } = await import('./service.js');
const { BrowserIPCServer, sendIPCRequest } = await import('./ipc.js');
const { actionsDir } = await import('../runtime/session-store.js');

let server: InstanceType<typeof BrowserIPCServer>;

beforeAll(async () => {
  server = new BrowserIPCServer(new BrowserService());
  await server.start();
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

it('a verb appends one timestamped action line, answered or refused', async () => {
  await sendIPCRequest({ action: 'version' }, { autoStartDaemon: false });
  const refused = await sendIPCRequest({ action: 'tab-list', task: 'no-such-task' }, { autoStartDaemon: false });
  expect(refused.ok).toBe(false);

  const file = path.join(actionsDir(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ event: 'browser.action', command: 'version', ok: true, pid: process.pid });
  expect(lines[1]).toMatchObject({ command: 'tab-list', task: 'no-such-task', ok: false, error: refused.error });
  expect(fs.statSync(actionsDir()).mode & 0o777).toBe(0o700);
  for (const line of lines) {
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
    expect(typeof line.ms).toBe('number');
  }
});
