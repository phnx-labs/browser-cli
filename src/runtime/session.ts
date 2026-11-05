import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether another live process names this session id in argv or `AGENT_SESSION_ID`. The
 * reaper closes a task on `false`, so an unreadable process table answers `true`.
 */
export function isSessionIdLiveOnProcessTable(id: string): boolean {
  if (!id) return true;
  const table = processTable();
  return table === null || table.includes(id);
}

const PROCESS_TABLE_TTL_MS = 2_000;
let processTableCache: { at: number; text: string | null } | undefined;

/** Every other process's argv and environment as one string, read once per reaper pass. */
function processTable(): string | null {
  const now = Date.now();
  if (processTableCache && now - processTableCache.at < PROCESS_TABLE_TTL_MS) return processTableCache.text;
  processTableCache = { at: now, text: readProcessTable() };
  return processTableCache.text;
}

function readProcessTable(): string | null {
  if (process.platform === 'darwin') {
    // -E appends each process's environment; macOS shows it for the caller's own processes.
    const ps = spawnSync('/bin/ps', ['-AwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ps.status !== 0 || !ps.stdout) return null;
    return ps.stdout
      .split('\n')
      .filter((line) => Number.parseInt(line, 10) !== process.pid)
      .join('\n');
  }
  if (process.platform === 'linux') {
    let pids: string[];
    try {
      pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid);
    } catch {
      return null;
    }
    const parts: string[] = [];
    for (const pid of pids) {
      for (const file of ['cmdline', 'environ']) {
        try {
          parts.push(fs.readFileSync(`/proc/${pid}/${file}`, 'latin1'));
        } catch {
          // Exited, or another user's process: neither can be this user's session.
        }
      }
    }
    return parts.join('\n');
  }
  return null;
}

export type PidSessionEntry = {
  pid: number;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  comm?: string;
  startedAtMs?: number;
};

export function listPidSessionEntries(): PidSessionEntry[] {
  return [];
}

export function sessionIdFromLivePid(_pid: number): string | undefined {
  return undefined;
}
