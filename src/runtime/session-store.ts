import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBrowserActionsDir } from './state.js';
import { writeTaskSummary, readTaskSummaries, pruneTaskSummaries, type TaskSummary } from './task-history.js';

export const ACTION_RETENTION_DAYS = 30;

export function actionsDir(): string {
  return getBrowserActionsDir();
}

function dayKey(ts: string): string {
  const d = new Date(ts);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

function dayFile(day: string): string {
  return path.join(actionsDir(), `${day}.jsonl`);
}

export function appendAction(record: Record<string, unknown>): void {
  const ts = typeof record.ts === 'string' ? record.ts : new Date().toISOString();
  const file = dayFile(dayKey(ts));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}

export function pruneActions(now = Date.now()): void {
  const dir = actionsDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  } catch {
    return;
  }
  const cutoff = now - ACTION_RETENTION_DAYS * 86400000;
  for (const name of names) {
    if (Date.parse(name.slice(0, 10)) >= cutoff) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* prune best-effort */ }
  }
}

export function recordBrowserSession(record: Omit<TaskSummary, 'startedAt' | 'lastActivity'> & { startedAt?: number; lastActivity?: number }): void {
  const now = Date.now();
  writeTaskSummary({ ...record, startedAt: record.startedAt ?? now, lastActivity: record.lastActivity ?? now });
}

export function listBrowserSessionRecords(profile?: string): TaskSummary[] {
  return readTaskSummaries(profile);
}

export function pruneToolSessions(): void {
  pruneTaskSummaries();
}
