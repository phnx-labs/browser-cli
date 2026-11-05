import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getHistoryDir, getBrowserHistoryPath } from './state.js';

export interface TaskSummary {
  profile: string;
  task: string;
  actor?: string;
  sessionId?: string;
  launchId?: string;
  machine?: string;
  startedAt: number;
  lastActivity: number;
  captureDir?: string;
  capturesRemote?: string;
  counts?: { screenshot: number; pdf: number; recording: number; download: number };
}

export const SUMMARY_RETENTION_DAYS = 365;

export function historyPath(): string {
  return getBrowserHistoryPath();
}

function openHistory(): Database {
  const file = historyPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, { create: true });
  try {
    chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        profile TEXT NOT NULL, task TEXT NOT NULL, last_activity INTEGER NOT NULL,
        record TEXT NOT NULL, native INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(profile, task));
      CREATE INDEX IF NOT EXISTS tasks_activity ON tasks(last_activity DESC);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);`);
    const hasNative = () => Boolean(db.query("SELECT 1 FROM pragma_table_info('tasks') WHERE name='native'").get());
    const version = () => (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (!hasNative() || version() < 2) {
      db.transaction(() => {
        if (!hasNative()) db.exec('ALTER TABLE tasks ADD COLUMN native INTEGER NOT NULL DEFAULT 1');
        if (version() < 2) db.exec('PRAGMA user_version=2');
      }).immediate();
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function put(db: Database, record: TaskSummary, native = true): void {
  db.query(`INSERT INTO tasks(profile,task,last_activity,record,native) VALUES(?,?,?,?,?)
    ON CONFLICT(profile,task) DO UPDATE SET
      last_activity=MAX(tasks.last_activity,excluded.last_activity), native=excluded.native,
      record=json_set(
        CASE WHEN excluded.last_activity >= tasks.last_activity
          THEN json_patch(tasks.record,excluded.record)
          ELSE json_patch(excluded.record,tasks.record) END,
        '$.lastActivity', MAX(tasks.last_activity,excluded.last_activity),
        '$.startedAt', MIN(json_extract(tasks.record,'$.startedAt'),json_extract(excluded.record,'$.startedAt')))`).run(
    record.profile, record.task, record.lastActivity, JSON.stringify(record), native ? 1 : 0,
  );
}

/** The browser owns this database. Never writes to the agent conversation index. */
export function writeTaskSummary(record: TaskSummary): void {
  if (!record.profile || !record.task) throw new Error('Browser history requires a profile and task.');
  if (!Number.isFinite(record.startedAt) || !Number.isFinite(record.lastActivity)) throw new Error('Browser history requires finite timestamps.');
  const db = openHistory();
  try { put(db, record); } finally { db.close(); }
}

/** Merge an old browser-owned database transactionally; the caller preserves the original file. */
export function mergeBrowserHistory(source: string): void {
  const old = new Database(source, { readonly: true });
  try {
    if (!old.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) return;
    const hasNative = Boolean(old.query("SELECT 1 FROM pragma_table_info('tasks') WHERE name='native'").get());
    const rows = old.query(`SELECT record, ${hasNative ? 'native' : '1 AS native'} FROM tasks`).all() as Array<{ record: string; native: number }>;
    const db = openHistory();
    try {
      db.transaction(() => {
        for (const row of rows) {
          const record = JSON.parse(row.record) as TaskSummary;
          if (!record.profile || !record.task || !Number.isFinite(record.startedAt) || !Number.isFinite(record.lastActivity)) {
            throw new Error(`Invalid task record in ${source}; original database retained`);
          }
          const existing = db.query('SELECT native FROM tasks WHERE profile=? AND task=?').get(record.profile, record.task) as { native: number } | null;
          put(db, record, Boolean(row.native || existing?.native));
        }
      }).immediate();
    } finally { db.close(); }
  } finally { old.close(); }
}

/** Explicit, repeatable adoption of legacy summaries; native records win. */
export function importLegacyHistory(source = join(getHistoryDir(), 'sessions', 'sessions.db')): number {
  if (!existsSync(source)) return 0;
  const db = openHistory();
  let legacy: Database | undefined;
  try {
    legacy = new Database(source, { readonly: true });
    if (!legacy.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_sessions'").get()) return 0;
    const rows = legacy.query('SELECT * FROM browser_sessions').all() as Array<Record<string, unknown>>;
    return db.transaction(() => {
      let imported = 0;
      const read = db.query('SELECT record,native FROM tasks WHERE profile=? AND task=?');
      for (const r of rows) {
        if (typeof r.profile !== 'string' || typeof r.task !== 'string') continue;
        const text = (key: string) => typeof r[key] === 'string' ? r[key] as string : undefined;
        const summary: TaskSummary = {
          profile: r.profile, task: r.task, actor: text('actor'), sessionId: text('session_id'),
          launchId: text('launch_id'), machine: text('machine'),
          startedAt: Number(r.started_at), lastActivity: Number(r.last_activity ?? r.started_at),
          captureDir: text('capture_dir'), capturesRemote: text('captures_remote'),
          counts: { screenshot: Number(r.screenshot_count ?? 0), pdf: Number(r.pdf_count ?? 0),
            recording: Number(r.recording_count ?? 0), download: Number(r.download_count ?? 0) },
        };
        if (!Number.isFinite(summary.startedAt) || !Number.isFinite(summary.lastActivity)) continue;
        const native = read.get(summary.profile, summary.task) as { record: string; native: number } | null;
        const merged = { ...summary, ...(native?.native ? JSON.parse(native.record) as TaskSummary : {}) };
        if (native && isDeepStrictEqual(JSON.parse(native.record), JSON.parse(JSON.stringify(merged)))) continue;
        put(db, merged, Boolean(native?.native));
        imported++;
      }
      db.query("INSERT OR IGNORE INTO migrations(name) VALUES('agents-history')").run();
      return imported;
    }).immediate();
  } finally { legacy?.close(); db.close(); }
}

/** Only first adoption reads the legacy index. Subsequent listing is tool-local. */
export function readTaskSummaries(profile?: string): TaskSummary[] {
  let needsImport = true;
  if (existsSync(historyPath())) {
    const check = openHistory();
    try { needsImport = !check.query("SELECT 1 FROM migrations WHERE name='agents-history'").get(); }
    finally { check.close(); }
  }
  if (needsImport) {
    try { importLegacyHistory(); }
    catch (error) { console.error(`Legacy browser history could not be imported: ${error instanceof Error ? error.message : String(error)}. Native history remains available.`); }
  }
  if (!existsSync(historyPath())) return [];
  const db = openHistory();
  try {
    const rows = profile
      ? db.query('SELECT record FROM tasks WHERE profile=? ORDER BY last_activity DESC').all(profile)
      : db.query('SELECT record FROM tasks ORDER BY last_activity DESC').all();
    return (rows as { record: string }[]).map(row => JSON.parse(row.record) as TaskSummary);
  } finally { db.close(); }
}

export function pruneTaskSummaries(now = Date.now()): number {
  if (!existsSync(historyPath())) return 0;
  const db = openHistory();
  try { return db.query('DELETE FROM tasks WHERE last_activity < ?').run(now - SUMMARY_RETENTION_DAYS * 86400000).changes; }
  finally { db.close(); }
}
