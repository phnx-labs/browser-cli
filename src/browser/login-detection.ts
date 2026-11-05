/**
 * Which login-gated services have a live session in a profile, from cookie presence only (values
 * are never decrypted). Advisory and never throws; an unreadable store is `unread`, not logged out.
 */

import * as fs from 'fs';
import { getBrowserLoginScratchDir } from '../runtime/state.js';
import * as path from 'path';
import Database from '../runtime/sqlite.js';
import { listProfiles, profileDataDirs, type BrowserProfile } from './profiles.js';

/** A login-gated service signature: host substrings + the auth-cookie names
 *  whose presence indicates a live session, plus optional login metadata. */
interface ServiceSignature {
  hosts: string[];
  cookies: string[];
  /**
   * Where an interactive login starts, and the explicit bundle key prefix for its
   * `<PREFIX>_USERNAME` / `<PREFIX>_PASSWORD` credentials (see `credKeysForService`).
   */
  login?: { loginUrl: string; keyPrefix: string };
}

/**
 * Known login-gated services: any listed auth cookie on a matching host (unexpired or session)
 * means logged in. Only definitive session tokens; a service without one is omitted, never guessed.
 */
export const AUTH_SIGNATURES: Record<string, ServiceSignature> = {
  linkedin: {
    hosts: ['linkedin.com'],
    cookies: ['li_at'],
    login: { loginUrl: 'https://www.linkedin.com/login', keyPrefix: 'LINKEDIN' },
  },
  google: {
    hosts: ['google.com'],
    cookies: ['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
    login: { loginUrl: 'https://accounts.google.com/', keyPrefix: 'GOOGLE' },
  },
  x: {
    hosts: ['x.com', 'twitter.com'],
    cookies: ['auth_token'],
    login: { loginUrl: 'https://x.com/login', keyPrefix: 'X' },
  },
  reddit: {
    hosts: ['reddit.com'],
    cookies: ['reddit_session', 'token_v2'],
    login: { loginUrl: 'https://www.reddit.com/login', keyPrefix: 'REDDIT' },
  },
  github: {
    hosts: ['github.com'],
    cookies: ['user_session'],
    login: { loginUrl: 'https://github.com/login', keyPrefix: 'GITHUB' },
  },
};

/**
 * The `<PREFIX>_USERNAME` / `<PREFIX>_PASSWORD` keys a profile's `--secrets` bundle holds for
 * `service`, or null when it has no login metadata.
 */
export function credKeysForService(service: string): { user: string; pass: string } | null {
  const login = AUTH_SIGNATURES[service]?.login;
  if (!login) return null;
  return { user: `${login.keyPrefix}_USERNAME`, pass: `${login.keyPrefix}_PASSWORD` };
}

export interface CookieRow {
  host_key: string;
  name: string;
}

/**
 * Now in Chromium's `expires_utc` epoch (microseconds since 1601) as a BigInt. Expiries exceed
 * 2^53, so the comparison stays in SQLite; node:sqlite throws RangeError on the way back to JS.
 */
function chromeNowMicrosBigInt(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 1000n;
}

function hostMatches(hostKey: string, host: string): boolean {
  return hostKey === host || hostKey === '.' + host || hostKey.endsWith('.' + host);
}

/**
 * Pure core: given a profile's (already expiry-filtered) cookie rows, return the
 * services with a live session. Exported for direct unit testing without disk.
 */
export function detectServices(rows: CookieRow[]): string[] {
  const services: string[] = [];
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    const found = rows.some(
      (r) => sig.cookies.includes(r.name) && sig.hosts.some((h) => hostMatches(r.host_key, h))
    );
    if (found) services.push(service);
  }
  return services;
}

/** Map a URL to a known login-gated service key, or null. */
export function serviceForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    if (sig.hosts.some((h) => host === h || host.endsWith('.' + h))) return service;
  }
  return null;
}

/** The most recently written of `names` across the profile dirs, or null. */
function newestDb(dirs: string[], names: string[][]): string | null {
  const found: { p: string; mtime: number }[] = [];
  for (const dir of dirs) {
    for (const rel of names) {
      const p = path.join(dir, ...rel);
      try {
        found.push({ p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* not present */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.p ?? null;
}

/** Where a profile's cookie and saved-login DBs are on this machine, or why
 *  they cannot be read here. */
function profileStores(profile: LoginProfile, endpointName?: string): { cookies: string; logins: string | null } | { reason: string } {
  const located = profileDataDirs(profile, endpointName);
  if ('reason' in located) return located;
  const cookies = newestDb(located.dirs, [['Cookies'], ['Network', 'Cookies']]);
  if (!cookies) return { reason: `no cookie store in ${located.dirs.join(', ')}` };
  return { cookies, logins: newestDb(located.dirs, [['Login Data']]) };
}

/**
 * Run `fn` on a temp copy of a Chromium SQLite store (with WAL/SHM) so a running browser's lock
 * never blocks us and the live file is untouched; `fallback` on any error.
 */
function withCopiedDb<T>(dbPath: string, fn: (db: InstanceType<typeof Database>) => T, fallback: T): T {
  let tmpDir: string | null = null;
  try {
    fs.mkdirSync(getBrowserLoginScratchDir(), { recursive: true, mode: 0o700 });
    tmpDir = fs.mkdtempSync(path.join(getBrowserLoginScratchDir(), 'db-'));
    const tmpDb = path.join(tmpDir, 'db');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmpDb + suffix);
    }
    const db = new Database(tmpDb);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }
}

/** Read (expiry-filtered) cookie rows from a Chromium cookie DB. null on failure. */
function readCookieRows(dbPath: string): CookieRow[] | null {
  return withCopiedDb(
    dbPath,
    (db) => {
      // Filter expiry in SQL (session cookies have expires_utc = 0; otherwise it
      // must be in the future) and select only text columns, so the huge
      // microsecond integer never crosses into JS.
      const rows = db
        .prepare('SELECT host_key, name FROM cookies WHERE expires_utc = 0 OR expires_utc > ?')
        .all(chromeNowMicrosBigInt()) as Array<{ host_key: unknown; name: unknown }>;
      return rows.map((r) => ({
        host_key: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
      }));
    },
    null,
  );
}

/** A saved-login row from Chromium `Login Data` (username plaintext; password
 *  encrypted and never read). */
export interface LoginRow {
  origin_url: string;
  username_value: string;
  signon_realm: string;
}

/** Read saved-login rows from a Chromium `Login Data` DB. Skips
 *  user-blacklisted origins ("never save"). Selects only text columns —
 *  `password_value` (encrypted) is never touched. [] on failure. */
function readLoginRows(dbPath: string): LoginRow[] {
  return withCopiedDb(
    dbPath,
    (db) => {
      const rows = db
        .prepare(
          'SELECT origin_url, username_value, signon_realm FROM logins WHERE blacklisted_by_user = 0',
        )
        .all() as Array<{ origin_url: unknown; username_value: unknown; signon_realm: unknown }>;
      return rows.map((r) => ({
        origin_url: String(r.origin_url ?? ''),
        username_value: String(r.username_value ?? ''),
        signon_realm: String(r.signon_realm ?? ''),
      }));
    },
    [] as LoginRow[],
  );
}

/**
 * Map saved logins to service → account username (identity, not session).
 * The first non-empty username per service wins.
 */
function accountsByService(rows: LoginRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.username_value) continue;
    const service = serviceForUrl(r.origin_url) ?? serviceForUrl(r.signon_realm);
    if (service && !out[service]) out[service] = r.username_value;
  }
  return out;
}

/** A profile as login detection needs it: where it runs and what it stores. */
export type LoginProfile = BrowserProfile & { devices?: string[] };

export interface ProfileLogins {
  logins: Array<{ service: string; username?: string }>;
  /** Why the profile's cookie store was not read here. Absent when it was read,
   *  so an empty `logins` then really means no live session. */
  unread?: string;
}

/**
 * The signed-in account (from saved logins) for each service with a live session cookie, so a
 * stale saved login for a service since logged out of never shows.
 */
export async function loginsWithAccountsForProfile(
  profile: LoginProfile,
  endpointName?: string,
): Promise<ProfileLogins> {
  const stores = profileStores(profile, endpointName);
  if ('reason' in stores) return { logins: [], unread: stores.reason };
  const rows = readCookieRows(stores.cookies);
  if (!rows) return { logins: [], unread: `cannot read ${stores.cookies}` };
  const active = detectServices(rows);
  if (active.length === 0 || !stores.logins) return { logins: active.map((service) => ({ service })) };
  const accounts = accountsByService(readLoginRows(stores.logins));
  return { logins: active.map((service) => ({ service, username: accounts[service] })) };
}

/** Profile names that have a live session for the given service. */
export async function profilesLoggedInto(service: string): Promise<string[]> {
  const profiles = await listProfiles();
  const out: string[] = [];
  for (const p of profiles) {
    const stores = profileStores(p);
    if ('reason' in stores) continue;
    if (detectServices(readCookieRows(stores.cookies) ?? []).includes(service)) out.push(p.name);
  }
  return out;
}
