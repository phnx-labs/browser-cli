import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  resolveArtifact,
  renderBrowserSessions,
  groupIntoRows,
  matchesBrowserSessionRow,
  loadTaskIdentities,
  buildBrowserSessionRows,
  type ProfileArtifacts,
  type BrowserArtifact,
  type TaskIdentity,
} from './sessions-list.js';
import { getProfileRuntimeDir } from './profiles.js';

// Pure selection + rendering logic (no filesystem). The bug surface is the
// `--open` selector precedence (latest / exact / substring) and the per-kind
// counts in the human table.

const groups: ProfileArtifacts[] = [
  {
    profile: 'work',
    artifacts: [
      { kind: 'download', name: 'report.pdf', path: '/b/work/downloads/report.pdf', bytes: 800_000, mtimeMs: 3000 },
      { kind: 'screenshot', task: 't1', name: '2000.png', path: '/b/work/sessions/t1/2000.png', bytes: 64_000, mtimeMs: 2000 },
    ],
  },
  {
    profile: 'personal',
    artifacts: [
      { kind: 'recording', task: 't2', name: '1000.webm', path: '/b/personal/sessions/t2/1000.webm', bytes: 5_000_000, mtimeMs: 1000 },
    ],
  },
];

describe('resolveArtifact', () => {
  it("'latest' picks the newest across all profiles", () => {
    expect(resolveArtifact(groups, 'latest')).toBe('/b/work/downloads/report.pdf');
  });

  it('matches an exact filename before falling back to substring', () => {
    expect(resolveArtifact(groups, '2000.png')).toBe('/b/work/sessions/t1/2000.png');
  });

  it('matches on a filename substring', () => {
    expect(resolveArtifact(groups, 'webm')).toBe('/b/personal/sessions/t2/1000.webm');
  });

  it('returns null when nothing matches', () => {
    expect(resolveArtifact(groups, 'nope.gif')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveArtifact([], 'latest')).toBeNull();
  });
});

describe('renderBrowserSessions', () => {
  it('summarizes per-kind counts per profile', () => {
    const out = renderBrowserSessions(groups);
    expect(out).toContain('work  screenshots 1  pdfs 0  recordings 0  downloads 1');
    expect(out).toContain('personal  screenshots 0  pdfs 0  recordings 1  downloads 0');
  });

  it('handles the no-profiles case', () => {
    expect(renderBrowserSessions([])).toBe('No browser profiles found.');
  });
});

// ─── Task-first grouping ───────────────────────────────────────────────────
// The disk readers below use real files in the machine's runtime dir under a random profile prefix,
// since CACHE_DIR resolves from HOME at module load.

const taskArtifacts = (task: string, mtimes: number[]): BrowserArtifact[] =>
  mtimes.map((mtimeMs, i) => ({
    kind: 'screenshot' as const,
    task,
    name: `${mtimeMs}.png`,
    path: `/b/work/sessions/${task}/${mtimeMs}.png`,
    bytes: 1000 + i,
    mtimeMs,
  }));

describe('groupIntoRows', () => {
  it('collapses every capture in a task to one row, newest artifact first', () => {
    const groups: ProfileArtifacts[] = [
      { profile: 'work', artifacts: taskArtifacts('heavy-task', [1000, 3000, 2000]) },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('task');
    expect(rows[0].task).toBe('heavy-task');
    expect(rows[0].artifacts.map((a) => a.mtimeMs)).toEqual([3000, 2000, 1000]);
    expect(rows[0].latestMtimeMs).toBe(3000);
    expect(rows[0].counts.screenshot).toBe(3);
  });

  it('separates downloads into their own row per profile, distinct from tasks', () => {
    const groups: ProfileArtifacts[] = [
      {
        profile: 'work',
        artifacts: [
          { kind: 'download', name: 'report.pdf', path: '/b/work/downloads/report.pdf', bytes: 500, mtimeMs: 5000 },
          ...taskArtifacts('t1', [1000]),
        ],
      },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows.map((r) => r.kind)).toEqual(['downloads', 'task']);
    expect(rows[0].task).toBeUndefined();
    expect(rows[0].counts.download).toBe(1);
    expect(rows[1].task).toBe('t1');
  });

  it('sorts rows across profiles newest-capture-first', () => {
    const groups: ProfileArtifacts[] = [
      { profile: 'old-profile', artifacts: taskArtifacts('t1', [1000]) },
      { profile: 'new-profile', artifacts: taskArtifacts('t2', [9000]) },
    ];
    const rows = groupIntoRows(groups, new Map());
    expect(rows.map((r) => r.profile)).toEqual(['new-profile', 'old-profile']);
  });

  it('marks a task unresolved when it records a launchId', () => {
    const groups: ProfileArtifacts[] = [{ profile: 'work', artifacts: taskArtifacts('t1', [1000]) }];
    const identities = new Map([['work', new Map<string, TaskIdentity>([['t1', { owner: 'me@laptop', launchId: 'launch-1' }]])]]);
    const rows = groupIntoRows(groups, identities);
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].owner).toBe('me@laptop');
    expect(rows[0].launchId).toBe('launch-1');
  });

  it('marks a task unlinked when tasks.json has no entry for it (a stopped/legacy task)', () => {
    const groups: ProfileArtifacts[] = [{ profile: 'work', artifacts: taskArtifacts('gone', [1000]) }];
    const rows = groupIntoRows(groups, new Map());
    expect(rows[0].linkStatus).toBe('unlinked');
    expect(rows[0].owner).toBeUndefined();
    expect(rows[0].launchId).toBeUndefined();
  });
});

describe('matchesBrowserSessionRow', () => {
  const linkedRow = groupIntoRows(
    [{ profile: 'work', artifacts: taskArtifacts('linked-task', [1000]) }],
    new Map([['work', new Map<string, TaskIdentity>([['linked-task', { owner: 'codex@laptop', launchId: 'l1' }]])]]),
  )[0];

  it('matches on task name', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'linked-task')).toBe(true);
    expect(matchesBrowserSessionRow(linkedRow, 'no-such-task')).toBe(false);
  });

  it('matches on profile', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'work')).toBe(true);
  });

  it('matches on the owner', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'codex')).toBe(true);
  });

  it('matches on an artifact filename', () => {
    expect(matchesBrowserSessionRow(linkedRow, '1000.png')).toBe(true);
  });

  it('is case-insensitive and treats a blank query as match-all', () => {
    expect(matchesBrowserSessionRow(linkedRow, 'CODEX')).toBe(true);
    expect(matchesBrowserSessionRow(linkedRow, '  ')).toBe(true);
  });

  it('the downloads row matches the literal word "downloads"', () => {
    const downloadsRow = groupIntoRows(
      [{ profile: 'work', artifacts: [{ kind: 'download', name: 'x.zip', path: '/b/work/downloads/x.zip', bytes: 1, mtimeMs: 1 }] }],
      new Map(),
    )[0];
    expect(matchesBrowserSessionRow(downloadsRow, 'download')).toBe(true);
  });
});

describe('loadTaskIdentities + buildBrowserSessionRows (real files)', () => {
  let profile: string;
  let root: string;
  let previousHistory: string | undefined;
  const extraDirs: string[] = [];

  beforeEach(() => {
    profile = `tst-linked-${crypto.randomBytes(6).toString('hex')}`;
    root = getProfileRuntimeDir(profile);
    previousHistory = process.env.AGENTS_HISTORY_DIR;
    process.env.AGENTS_HISTORY_DIR = path.join(root, 'test-history');
  });

  afterEach(() => {
    if (previousHistory === undefined) delete process.env.AGENTS_HISTORY_DIR;
    else process.env.AGENTS_HISTORY_DIR = previousHistory;
    fs.rmSync(root, { recursive: true, force: true });
    for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
    extraDirs.length = 0;
  });

  it('reads owner/launchId for a live task and ignores fields it does not know', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'tasks.json'),
      JSON.stringify({
        'my-task': { id: 'abc', name: 'my-task', profile, owner: 'user@laptop', launchId: 'launch-xyz', pid: 123, tabs: {} },
      }),
    );
    const identities = loadTaskIdentities(profile);
    expect(identities.get('my-task')).toEqual({ owner: 'user@laptop', launchId: 'launch-xyz' });
  });

  it('returns an empty map when tasks.json is absent (a fresh or already-stopped profile)', () => {
    expect(loadTaskIdentities(profile).size).toBe(0);
  });

  it('returns an empty map instead of throwing on corrupt JSON', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks.json'), '{not json');
    expect(loadTaskIdentities(profile).size).toBe(0);
  });

  it('groups real on-disk captures by task and reports an unresolved link for a launchId this machine cannot join', () => {
    const sessionsDir = path.join(root, 'sessions', 'my-task');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'one.png'), 'fake-png');
    fs.writeFileSync(path.join(sessionsDir, 'two.png'), 'fake-png');
    fs.writeFileSync(
      path.join(root, 'tasks.json'),
      JSON.stringify({ 'my-task': { id: 'abc', name: 'my-task', profile, owner: 'user@laptop', launchId: `no-such-launch-${profile}`, pid: 1, tabs: {} } }),
    );

    const rows = buildBrowserSessionRows(profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('my-task');
    expect(rows[0].artifacts).toHaveLength(2);
    // A launchId this test just invented can't be indexed anywhere on the
    // machine, so the row must report unresolved (has an owner + launchId,
    // but no linked session) rather than silently claiming a link.
    expect(rows[0].linkStatus).toBe('unresolved');
    expect(rows[0].owner).toBe('user@laptop');
  });

  it('surfaces tasks stored under the composite `<profile>@<device>` dir when queried by the bare profile name', () => {
    // The daemon stores tasks in the composite dir, so the bare name must resolve to it.
    const compositeDir = getProfileRuntimeDir(`${profile}@laptop`);
    extraDirs.push(compositeDir);

    // Bare dir exists but is empty — exactly the stranded legacy layout.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks.json'), '{}');

    // Real task + capture live under the composite dir.
    const sessionsDir = path.join(compositeDir, 'sessions', 'demo');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'shot.png'), 'fake-png');
    fs.writeFileSync(
      path.join(compositeDir, 'tasks.json'),
      JSON.stringify({ 'demo': { id: 'abc', name: 'demo', profile: `${profile}@laptop`, owner: 'claude@box-c', launchId: `no-such-launch-${profile}`, pid: 0, tabs: {} } }),
    );

    const rows = buildBrowserSessionRows(profile);
    const taskRow = rows.find((r) => r.task === 'demo');
    expect(taskRow).toBeDefined();
    expect(taskRow!.artifacts).toHaveLength(1);
    expect(taskRow!.owner).toBe('claude@box-c');
  });
});
