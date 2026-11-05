import { afterEach, beforeEach, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACTION_RETENTION_DAYS, actionsDir, pruneActions } from './session-store.js';

let home: string;
const previous = process.env.AGENTS_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-actions-'));
  process.env.AGENTS_HOME = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

it(`removes action files older than ${ACTION_RETENTION_DAYS} days and leaves the rest`, () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  fs.mkdirSync(actionsDir(), { recursive: true });
  for (const name of ['2026-09-20.jsonl', '2026-09-28.jsonl', '2026-10-27.jsonl', 'notes.txt']) {
    fs.writeFileSync(path.join(actionsDir(), name), '{}\n');
  }
  pruneActions(now);
  expect(fs.readdirSync(actionsDir()).sort()).toEqual(['2026-09-28.jsonl', '2026-10-27.jsonl', 'notes.txt']);
});
