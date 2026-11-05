import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordBrowserSession, listBrowserSessionRecords } from './session-store.js';
import { importLegacyHistory, pruneTaskSummaries, readTaskSummaries } from './task-history.js';
import { buildBrowserSessionRows } from '../browser/sessions-list.js';

let root: string;
let previous: NodeJS.ProcessEnv;
beforeEach(() => {
  previous = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'history-test-'));
  process.env.AGENTS_HOME = root;
  process.env.AGENTS_HISTORY_DIR = join(root, 'history');
});
afterEach(() => { process.env = previous; rmSync(root, { recursive: true, force: true }); });

describe('standalone browser history', () => {
  it.each([0, 1])('migrates history without native at user_version %i and preserves old tasks', (version) => {
    const dir = join(root, 'browser', 'data');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'history.db');
    const oldRecord = { profile: 'work', task: 'old-task', startedAt: 1000, lastActivity: 1500 };
    const legacy = new Database(file);
    try {
      legacy.exec(readFileSync(join(import.meta.dir, 'testdata', 'history-before-native.sql'), 'utf8'));
      legacy.exec(`PRAGMA user_version=${version}`);
      legacy.query('INSERT INTO tasks VALUES(?,?,?,?)').run('work', 'old-task', 1500, JSON.stringify(oldRecord));
    } finally { legacy.close(); }

    recordBrowserSession({ profile: 'work', task: 'saved-again', startedAt: 2000, lastActivity: 3000 });
    expect(readTaskSummaries('work')).toEqual([
      { profile: 'work', task: 'saved-again', startedAt: 2000, lastActivity: 3000 },
      oldRecord,
    ]);
    recordBrowserSession({ profile: 'work', task: 'saved-again', startedAt: 2000, lastActivity: 4000 });
    const db = new Database(file, { readonly: true });
    try {
      expect(db.query('SELECT task, native, last_activity FROM tasks ORDER BY task').all()).toEqual([
        { task: 'old-task', native: 1, last_activity: 1500 },
        { task: 'saved-again', native: 1, last_activity: 4000 },
      ]);
      expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    } finally { db.close(); }
  });

  it('keeps identity after later updates and separates equal task names across profiles', () => {
    recordBrowserSession({ profile: 'personal', task: 'review', sessionId: 'conversation-a', startedAt: 10 });
    recordBrowserSession({ profile: 'personal', task: 'review', startedAt: 10, captureDir: '/captures/review' });
    recordBrowserSession({ profile: 'work', task: 'review', sessionId: 'conversation-b' });
    expect(listBrowserSessionRecords('personal')).toMatchObject([{ sessionId: 'conversation-a', startedAt: 10, captureDir: '/captures/review' }]);
    expect(listBrowserSessionRecords('work')).toMatchObject([{ sessionId: 'conversation-b' }]);
  });

  it('keeps monotonic activity, the first start, and newer identity after an out-of-order write', () => {
    recordBrowserSession({ profile: 'work', task: 'review', startedAt: 10, lastActivity: 30, sessionId: 'new' });
    recordBrowserSession({ profile: 'work', task: 'review', startedAt: 15, lastActivity: 20, sessionId: 'old' });
    expect(readTaskSummaries('work')).toMatchObject([{ startedAt: 10, lastActivity: 30, sessionId: 'new' }]);
  });

  it('imports legacy metadata once, fills missing native identity, and never edits the source', () => {
    const source = join(root, 'legacy.db');
    const legacy = new Database(source);
    legacy.exec('CREATE TABLE browser_sessions (profile TEXT, task TEXT, session_id TEXT, started_at INTEGER, last_activity INTEGER, screenshot_count INTEGER)');
    legacy.query('INSERT INTO browser_sessions VALUES(?,?,?,?,?,?)').run('work', 'review', 'old-conversation', 10, 20, 4);
    recordBrowserSession({ profile: 'work', task: 'review', startedAt: 30, lastActivity: 40 });
    expect(importLegacyHistory(source)).toBe(1);
    expect(importLegacyHistory(source)).toBe(0);
    expect(readTaskSummaries('work')).toMatchObject([{ sessionId: 'old-conversation', startedAt: 30, lastActivity: 40, counts: { screenshot: 4 } }]);
    expect(legacy.query('SELECT last_activity FROM browser_sessions').get()).toEqual({ last_activity: 20 });
    legacy.close();
  });

  it('lists finished tasks without captures, scopes composite profiles and never needs a conversation index', () => {
    recordBrowserSession({ profile: 'work@worker', task: 'no-captures', sessionId: 'conversation-c' });
    recordBrowserSession({ profile: 'work-other', task: 'unrelated' });
    const rows = buildBrowserSessionRows('work');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: 'no-captures', profile: 'work@worker', sessionId: 'conversation-c', artifacts: [], linkStatus: 'unresolved' });
  });

  it('retains summaries older than the action log while expiring only the 365-day horizon', () => {
    const now = Date.now();
    recordBrowserSession({ profile: 'work', task: 'kept', lastActivity: now - 90 * 86400000 });
    recordBrowserSession({ profile: 'work', task: 'expired', lastActivity: now - 366 * 86400000 });
    expect(pruneTaskSummaries(now)).toBe(1);
    expect(readTaskSummaries().map(row => row.task)).toEqual(['kept']);
  });

  it('refreshes imported-only summaries and keeps native history readable if the optional legacy index is corrupt', () => {
    const source = join(root, 'history', 'sessions', 'sessions.db');
    mkdirSync(join(root, 'history', 'sessions'), { recursive: true });
    const db = new Database(source);
    db.exec('CREATE TABLE browser_sessions (profile TEXT,task TEXT,started_at INTEGER,last_activity INTEGER,screenshot_count INTEGER)');
    db.query('INSERT INTO browser_sessions VALUES(?,?,?,?,?)').run('work','legacy',10,20,1);
    expect(importLegacyHistory(source)).toBe(1);
    db.exec('UPDATE browser_sessions SET last_activity=30,screenshot_count=5');
    expect(importLegacyHistory(source)).toBe(1);
    expect(readTaskSummaries()).toMatchObject([{ lastActivity:30,counts:{ screenshot:5 } }]);
    db.close();
    // A different native store has not adopted the optional source yet.
    process.env.AGENTS_HOME = join(root, 'fresh-home');
    process.env.AGENTS_HISTORY_DIR = join(root, 'fresh-history');
    mkdirSync(join(root,'fresh-history','sessions'), {recursive:true});
    writeFileSync(join(root,'fresh-history','sessions','sessions.db'), 'corrupt');
    recordBrowserSession({profile:'work',task:'native'});
    expect(readTaskSummaries().map(row=>row.task)).toEqual(['native']);
  });

  it('reports a corrupt legacy source instead of accepting an empty migration', () => {
    const source = join(root, 'broken.db');
    writeFileSync(source, 'not a sqlite database');
    expect(() => importLegacyHistory(source)).toThrow();
  });
});
