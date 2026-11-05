import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import lockfile from 'proper-lockfile';
import { storeOccupant } from '../browser/chrome.js';
import { isProcessAlive } from '../browser/runtime-state.js';
import { stopLegacyBrowserService } from './service.js';
import { mergeBrowserHistory } from './task-history.js';
import { browserStateMoves, readBrowserSettings, updateMeta, getBrowserHistoryPath, getLegacyBrowserRuntimeDir,
  getLegacyBrowserDurableDir, getBrowserLocalDir, getBrowserMigrationLockPath, getBrowserConflictDir,
  getBrowserActionsDir, getLegacyBrowserActionsDir, getBrowserMigrationMarkerPath, getBrowserSettingsPath, setBrowserMigrationBlock } from './state.js';

const TOMBSTONE = 'Browser data moved. Use the current browser CLI; do not recreate this directory.\n';
type Move = [source: string, destination: string];

/** One entry point, before any CLI or daemon action can create browser state. */
export async function migrateBrowserHome(log: (message: string) => void = console.error): Promise<boolean> {
  if (migrationComplete()) return true;
  let release: () => Promise<void>;
  try {
    fs.mkdirSync(getBrowserLocalDir(), { recursive: true, mode: 0o700 });
    release = await lockfile.lock(getBrowserLocalDir(), {
      lockfilePath: getBrowserMigrationLockPath(), realpath: false, stale: 30_000,
      retries: { retries: 100, minTimeout: 50, maxTimeout: 100 },
    });
  } catch (error) {
    const reason = `Cannot lock browser migration at ${getBrowserMigrationLockPath()}: ${error instanceof Error ? error.message : String(error)}. Retry after the other migration finishes or repair the lock directory permissions.`;
    setBrowserMigrationBlock(reason);
    log(`browser migration: ${reason} Commands that need no daemon can continue.`);
    return false;
  }
  try {
    if (migrationComplete()) return true;
    if (!(await stopLegacyBrowserService(log))) {
      setBrowserMigrationBlock('The old browser service is still active or unverifiable. Stop it, then restart the browser service before driving a browser.');
      return true;
    }
    setBrowserMigrationBlock();
    const warnings: string[] = [];
    const moved: Move[] = [];
    const blocked = await liveProfileStores(warnings);
    const actions: Move = [getLegacyBrowserActionsDir(), getBrowserActionsDir()];
    moveEntry(...actions, blocked, moved, warnings);
    for (const [source, destination] of browserStateMoves()) {
      if (isTombstone(source)) continue;
      moveEntry(source, destination, blocked, moved, warnings);
      if (!source.endsWith('.log') && !stat(source)) {
        try {
          fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
          fs.writeFileSync(source, TOMBSTONE, { flag: 'wx', mode: 0o600 });
        } catch (error) { warnings.push(moveWarning(source, destination, error)); }
      }
    }
    try { migrateCapturePaths(moved); }
    catch (error) { warnings.push(`history capture paths were left unchanged: ${error instanceof Error ? error.message : String(error)}`); }
    readBrowserSettings();
    updateMeta(meta => meta);
    fs.writeFileSync(getBrowserMigrationMarkerPath(), '1\n', { mode: 0o600 });
    if (warnings.length) log(`browser migration: ${warnings.join('; ')}`);
    return true;
  } finally { await release(); }
}

function migrationComplete(): boolean {
  if (!fs.existsSync(getBrowserMigrationMarkerPath()) || !fs.existsSync(getBrowserSettingsPath())) return false;
  if (!browserStateMoves().every(([source]) => !stat(source) || isTombstone(source))) return false;
  setBrowserMigrationBlock();
  return true;
}

function stat(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

function isTombstone(file: string): boolean {
  const info = stat(file);
  return info?.isFile() === true && info.size === Buffer.byteLength(TOMBSTONE) && fs.readFileSync(file, 'utf8') === TOMBSTONE;
}

function moveWarning(source: string, destination: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reason = code === 'EXDEV' ? 'EXDEV (different filesystems)' : error instanceof Error ? error.message : String(error);
  return `left ${source} in place (${reason}). Close the browser using it, move it by hand to ${destination} without overwriting existing data, then rerun browser`;
}

function preserveConflict(source: string, destination: string, moved: Move[], warnings: string[]): void {
  fs.mkdirSync(getBrowserConflictDir(), { recursive: true, mode: 0o700 });
  const container = fs.mkdtempSync(path.join(getBrowserConflictDir(), `${path.basename(source)}-`));
  const backup = path.join(container, path.basename(source));
  try {
    fs.renameSync(source, backup);
    moved.push([source, backup]);
    warnings.push(`kept ${source} at ${backup}; reconcile it with ${destination} before removing the backup`);
  } catch (error) {
    fs.rmdirSync(container);
    throw error;
  }
}

function moveEntry(source: string, destination: string, blocked: Set<string>, moved: Move[], warnings: string[]): void {
  if (blocked.has(source)) return;
  try {
    const from = stat(source);
    if (!from) return;
    const to = stat(destination);
    const containsBlocked = [...blocked].some(file => file.startsWith(source + path.sep));
    if (from.isDirectory() && to && !to.isDirectory()) {
      preserveConflict(destination, source, moved, warnings);
      moveEntry(source, destination, blocked, moved, warnings);
    } else if (!to && !containsBlocked) {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.renameSync(source, destination);
      moved.push([source, destination]);
    } else if (from.isDirectory() && (!to || to.isDirectory())) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      let historyConflict = false;
      for (const entry of fs.readdirSync(source).sort()) {
        if (path.join(destination, entry) === getBrowserHistoryPath() && stat(path.join(destination, entry))) {
          mergeBrowserHistory(path.join(source, entry));
          historyConflict = true;
        } else if (!(historyConflict && ['history.db-wal', 'history.db-shm', 'history.db-journal'].includes(entry))) {
          moveEntry(path.join(source, entry), path.join(destination, entry), blocked, moved, warnings);
        }
      }
      if (historyConflict) {
        preserveConflict(source, destination, moved, warnings);
      } else if (fs.readdirSync(source).length === 0) {
        fs.rmdirSync(source);
        moved.push([source, destination]);
      }
    } else {
      preserveConflict(source, destination, moved, warnings);
    }
  } catch (error) { warnings.push(moveWarning(source, destination, error)); }
}

async function liveProfileStores(warnings: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  const runtime = getLegacyBrowserRuntimeDir();
  const cacheEntries = stat(runtime)?.isDirectory() ? fs.readdirSync(runtime) : [];
  for (const root of [runtime, getLegacyBrowserDurableDir()]) {
    if (!stat(root)?.isDirectory()) continue;
    for (const name of fs.readdirSync(root)) {
      const directory = path.join(root, name);
      if (!stat(directory)?.isDirectory()) continue;
      const related = root === runtime ? [directory] : cacheEntries
        .filter(entry => entry === name || entry.startsWith(`${name}@`)).map(entry => path.join(runtime, entry));
      const owner = await liveStoreOwner(directory, related);
      if (!owner) continue;
      blocked.add(directory);
      warnings.push(`left ${directory} in place: ${owner}. Close that browser, then rerun browser and restart its service`);
    }
  }
  return blocked;
}

async function liveStoreOwner(directory: string, runtimeDirs: string[]): Promise<string | undefined> {
  for (const store of [directory, path.join(directory, 'chrome-data')]) {
    const owner = storeOccupant(store);
    if (owner) return `browser PID ${owner.pid} holds ${store}`;
    try {
      const port = Number(fs.readFileSync(path.join(store, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && await portAlive(port)) return `a browser listens on DevTools port ${port} for ${store}`;
    } catch { /* no DevTools endpoint */ }
  }
  for (const runtime of runtimeDirs) {
    for (const file of ['meta.json', 'tasks.json']) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(runtime, file), 'utf8'));
        const entries = file === 'meta.json' ? [record] : Object.values(record);
        for (const entry of entries as Array<{ pid?: number; command?: string }>) {
          if (Number.isInteger(entry?.pid) && entry.pid! > 0 && isProcessAlive(entry.pid!, entry.command)) return `browser PID ${entry.pid} recorded in ${path.join(runtime, file)}`;
        }
      } catch { /* no runtime PID */ }
    }
  }
}

function portAlive(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (alive: boolean) => { socket.destroy(); resolve(alive); };
    socket.setTimeout(150);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function migrateCapturePaths(moved: Move[]): void {
  const file = getBrowserHistoryPath();
  if (!fs.existsSync(file) || !moved.length) return;
  const db = new Database(file);
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) return;
    const moves = [...moved].sort((a, b) => b[0].length - a[0].length);
    db.transaction(() => {
      const rows = db.query('SELECT profile, task, record FROM tasks').all() as Array<{ profile: string; task: string; record: string }>;
      const update = db.query('UPDATE tasks SET record=? WHERE profile=? AND task=?');
      for (const row of rows) {
        const record = JSON.parse(row.record);
        if (typeof record.captureDir !== 'string' || record.capturesRemote) continue;
        const move = moves.find(([source]) => record.captureDir === source || record.captureDir.startsWith(source + path.sep));
        if (!move) continue;
        record.captureDir = move[1] + record.captureDir.slice(move[0].length);
        update.run(JSON.stringify(record), row.profile, row.task);
      }
    })();
  } finally { db.close(); }
}
