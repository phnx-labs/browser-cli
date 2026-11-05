/**
 * SQLite through `bun:sqlite` under Bun or `node:sqlite` under Node (>=22.5), with no
 * native addon to mismatch, behind the small better-sqlite3-shaped surface the code uses.
 */

import { createRequire } from 'module';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const require = createRequire(import.meta.url);

// node:sqlite emits an ExperimentalWarning on first load, which a direct `node` run
// would leak onto stderr next to clean --json output. Suppress only that warning,
// only for the duration of the load.
function loadNodeSqlite(): unknown {
  const original = process.emitWarning;
  const filtered = ((warning: string | Error, ...rest: unknown[]): void => {
    const name = warning instanceof Error
      ? warning.name
      : typeof rest[0] === 'string'
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
    const message = warning instanceof Error ? warning.message : warning;
    if (name === 'ExperimentalWarning' && /SQLite/i.test(String(message ?? ''))) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

// Synchronous createRequire() on both runtimes: a top-level await cannot be lowered
// to CJS. The specifier sits in a variable because a literal `require('bun:sqlite')`
// is statically analyzable, and bundlers would try to resolve it off-Bun.
const BUN_SQLITE = 'bun:sqlite';
const sqliteMod = isBun
  ? (require as (id: string) => unknown)(BUN_SQLITE)
  : loadNodeSqlite();

// bun:sqlite exports `Database`; node:sqlite exports `DatabaseSync`.
const NativeDatabase: new (filename: string, options?: { strict: boolean }) => NativeDb =
  (sqliteMod as { Database?: unknown; DatabaseSync?: unknown }).Database as never
  ?? (sqliteMod as { DatabaseSync?: unknown }).DatabaseSync as never;

// `strict: true` lets bun bind bare named keys (`{ id }`) as node does; without it every
// parameter stays NULL. Keep binds in both runtimes' intersection: pass exactly the named
// keys, never sigil keys (`{'@id'}`) or a lone non-plain object positional (`new Date()`).
const NATIVE_ARGS: [] | [{ strict: boolean }] = isBun ? [{ strict: true }] : [];

interface NativeStmt {
  run(...args: unknown[]): RunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface NativeDb {
  prepare(sql: string): NativeStmt;
  exec(sql: string): void;
  close(): void;
}

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

function bindArgs(params: unknown[]): unknown[] {
  // Both bindings accept positional `(a, b, c)` and named `({ a, b, c })`
  // forms — bun only under `strict: true` (see NATIVE_ARGS). Pass an object
  // through unchanged so callers using named binds work.
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    return [params[0]];
  }
  return params;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
class StatementImpl<_T = unknown> {
  constructor(private readonly inner: NativeStmt) {}

  run(...params: unknown[]): RunResult {
    return this.inner.run(...bindArgs(params));
  }

  get(...params: unknown[]): unknown {
    return this.inner.get(...bindArgs(params));
  }

  all(...params: unknown[]): unknown[] {
    return this.inner.all(...bindArgs(params));
  }
}

class Database {
  private readonly inner: NativeDb;

  constructor(filename: string) {
    this.inner = new NativeDatabase(filename, ...NATIVE_ARGS);
  }

  prepare<T = unknown>(sql: string): StatementImpl<T> {
    return new StatementImpl<T>(this.inner.prepare(sql));
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  // node:sqlite has no dedicated `pragma()` and bun:sqlite's signature differs
  // slightly from better-sqlite3. `exec('PRAGMA ...')` works on both and is
  // sufficient for the setter pragmas (`journal_mode = WAL`) used here.
  // Reader pragmas in this codebase use `db.prepare(...).all()`.
  pragma(stmt: string): void {
    this.inner.exec(`PRAGMA ${stmt}`);
  }

  // Manual BEGIN IMMEDIATE/COMMIT, ROLLBACK on throw (node:sqlite has no transaction()).
  // IMMEDIATE claims the WAL write lock upfront; DEFERRED can hit SQLITE_BUSY_SNAPSHOT,
  // which the busy handler does not retry, so busy_timeout would not apply.
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args): R => {
      this.inner.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        this.inner.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.inner.exec('ROLLBACK'); } catch { /* original error wins */ }
        throw err;
      }
    };
  }

  close(): void {
    this.inner.close();
  }
}

// Declaration merging keeps `Database.Database` / `Database.Statement<T>`
// type references at call sites working without rewrites.
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Database {
  export type Database = InstanceType<typeof DatabaseConstructor>;
  export type Statement<T = unknown> = StatementImpl<T>;
}

const DatabaseConstructor = Database;

export default Database;
