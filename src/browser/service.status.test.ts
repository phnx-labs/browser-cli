import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';

/**
 * Redirect the agents home BEFORE importing the service, so this suite uses a
 * throwaway directory; `getAgentsHome` reads `AGENTS_HOME` on every call.
 */
const TEST_HOME = path.join(tmpdir(), `browser-cli-status-test-${process.pid}`);
process.env.AGENTS_HOME = TEST_HOME;
process.env.AGENTS_HISTORY_DIR = path.join(TEST_HOME, '.history');
const RUNTIME_DIR = path.join(TEST_HOME, 'browser', 'cache');

const { BrowserService } = await import('./service.js');

beforeEach(() => {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * An action still refuses a tab its task no longer owns, but read-only status
 * must not fail every profile because one Arc task's tab moved or was deleted.
 */
describe('BrowserService.status — a stale Arc task must not abort the listing', () => {
  /**
   * `moved: true` gives the tab's ref a different window than the task recorded,
   * which is how a moved tab looks on disk, so the real `requireArcTask` rejects it.
   */
  function registerArcProfile(
    service: InstanceType<typeof BrowserService>,
    key: string,
    opts: { moved: boolean; tabIds: string[] },
  ): void {
    const windowId = 'window-1';
    const tabs: Record<string, { windowId: string; spaceId: string; tabId: string }> = {};
    for (const id of opts.tabIds) {
      tabs[id] = {
        windowId: opts.moved ? 'window-2-somewhere-else' : windowId,
        spaceId: 'space-1',
        tabId: `arc-${id}`,
      };
    }
    const task = {
      id: 'arc-task-1',
      name: 'stale-arc-task',
      label: 'stale-arc-task',
      profile: key,
      tabs: Object.fromEntries(opts.tabIds.map((id) => [id, `arc-${id}`])),
      currentTabId: opts.tabIds[0],
      createdAt: 1_700_000_000_000,
      lastActionAt: 1_700_000_000_000,
      pid: 0,
      arcNative: {
        profileId: 'arc-profile',
        windowId,
        spaceId: 'space-1',
        spaceTitle: 'Work',
        tabs,
      },
    };
    (service as unknown as { connections: Map<string, unknown> }).connections.set(key, {
      backend: 'arc-native',
      key,
      profile: key.split('@')[0],
      tasks: new Map([[task.name, task]]),
      sessionCache: new Map(),
      port: 0,
      pid: 0,
      electron: false,
      browserType: 'arc',
      arcProfile: 'arc-profile',
    });
  }

  it('still lists the Arc profile, and says its tabs could not be read', async () => {
    const service = new BrowserService();
    registerArcProfile(service, 'arc-primary', { moved: true, tabIds: ['t1', 't2'] });

    const result = await service.status('arc-primary');

    const arc = result.find((p) => p.name === 'arc-primary');
    expect(arc).toBeDefined();

    const task = arc!.tasks[0];
    expect(task.unavailable).toMatch(/stable id in its original window/);
    // Never claims the stale tabs are live: absent, not an empty array.
    expect(task.tabs).toBeUndefined();
    expect(task.domains).toEqual([]);
    // The recorded count is on-disk truth and stays.
    expect(task.tabCount).toBe(2);
  });

  it('reports every Arc profile when several have stale tasks', async () => {
    const service = new BrowserService();
    registerArcProfile(service, 'arc-one', { moved: true, tabIds: ['t1'] });
    registerArcProfile(service, 'arc-two', { moved: true, tabIds: ['t9'] });

    const result = await service.status();
    const names = result.map((p) => p.name);

    expect(names).toContain('arc-one');
    expect(names).toContain('arc-two');
    expect(result.find((p) => p.name === 'arc-one')!.tasks[0].unavailable).toBeTruthy();
  });
});

/**
 * The snapshot path status uses instead of asking Arc about each tab, fed the
 * shape `enumerateArcSpaces` returns. Arc's speed on macOS needs a real Mac run.
 */
describe('listArcTaskTabsFromSnapshot — ownership against one shared snapshot', () => {
  const SNAPSHOT = [
    {
      windowId: 'window-1',
      spaceId: 'space-1',
      spaceTitle: 'Work',
      tabs: [
        { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t1', url: 'https://example.com/a', title: 'A' },
        { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t2', url: 'https://example.org/b', title: 'B' },
      ],
    },
  ];

  function task(tabs: Record<string, { windowId: string; spaceId: string; tabId: string }>) {
    return {
      id: 'arc-task-1',
      name: 'work',
      profile: 'arc-primary',
      tabs: Object.fromEntries(Object.keys(tabs).map((k) => [k, `arc-${k}`])),
      currentTabId: 't1',
      createdAt: 1_700_000_000_000,
      arcNative: {
        profileId: 'arc-profile',
        windowId: 'window-1',
        spaceId: 'space-1',
        spaceTitle: 'Work',
        tabs,
      },
    };
  }

  function resolveWith(t: unknown, spaces: () => Promise<unknown>) {
    const service = new BrowserService();
    return (
      service as unknown as {
        listArcTaskTabsFromSnapshot: (t: unknown, s: () => Promise<unknown>) => Promise<unknown>;
      }
    ).listArcTaskTabsFromSnapshot(t, spaces);
  }

  it('resolves every owned tab from the snapshot, with url, title and current', async () => {
    const tabs = await resolveWith(
      task({
        t1: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t1' },
        t2: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-t2' },
      }),
      async () => SNAPSHOT,
    );

    expect(tabs).toEqual([
      { id: 't1', url: 'https://example.com/a', title: 'A', task: 'work', current: true },
      { id: 't2', url: 'https://example.org/b', title: 'B', task: 'work', current: false },
    ]);
  });

  it('refuses a tab that is no longer in the snapshot (closed)', async () => {
    await expect(
      resolveWith(
        task({ t1: { windowId: 'window-1', spaceId: 'space-1', tabId: 'arc-gone' } }),
        async () => SNAPSHOT,
      ),
    ).rejects.toThrow(/missing from its original window\/Space/);
  });

  it('refuses a moved tab from the record alone, before reading the snapshot', async () => {
    // The snapshot would match this tab id, but the ref names a window the task
    // does not own, so ownership fails first. That ordering is why a stale task
    // reports the right reason even when Arc cannot be reached.
    let snapshotRead = false;
    await expect(
      resolveWith(
        task({ t1: { windowId: 'window-2-somewhere-else', spaceId: 'space-1', tabId: 'arc-t1' } }),
        async () => {
          snapshotRead = true;
          return SNAPSHOT;
        },
      ),
    ).rejects.toThrow(/stable id in its original window/);

    expect(snapshotRead).toBe(false);
  });
});

/**
 * Cold status: nothing in memory, saved runtime dirs on disk, one of them a truncated
 * `tasks.json` as a crash mid-write leaves. Rehydration runs before any per-profile guard.
 */
describe('BrowserService.status — a cold pass survives an unreadable saved profile', () => {
  it('reports a live-but-unreadable runtime exactly ONCE, not twice', async () => {
    // A runtime with a valid pid/port AND a corrupt tasks.json is seen by both
    // rehydration and the disk reconcile, since both read that same file.
    // Reported once, keyed by the runtime that actually failed.
    const dir = path.join(RUNTIME_DIR, 'half-broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(dir, 'port'), '9333');
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');

    const service = new BrowserService();
    const result = await service.status('half-broken');

    const rows = result.filter((p) => p.name === 'half-broken');
    expect(rows).toHaveLength(1);
    expect(rows[0].unavailable).toBeTruthy();
    expect(rows[0].key).toBe('half-broken');
  });

  it('names the runtime that actually failed, not the first one listed', async () => {
    // Two runtimes for one profile: the FIRST is dead (no pid/port) and the
    // SECOND is live but corrupt. Reporting the first would name the wrong dir.
    fs.mkdirSync(path.join(RUNTIME_DIR, 'two-runtimes'), { recursive: true });
    const live = path.join(RUNTIME_DIR, 'two-runtimes@device-b');
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'pid'), String(process.pid));
    fs.writeFileSync(path.join(live, 'port'), '9444');
    fs.writeFileSync(path.join(live, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');

    const service = new BrowserService();
    const result = await service.status('two-runtimes');

    const row = result.find((p) => p.unavailable);
    expect(row).toBeDefined();
    expect(row!.key).toBe('two-runtimes@device-b');
  });

  it('reports the unreadable profile instead of emptying the listing', async () => {
    const dir = path.join(RUNTIME_DIR, 'broken-profile');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks.json'), '{"task-a": {"id": "a", "tabs":');

    const service = new BrowserService();
    const result = await service.status('broken-profile');

    const broken = result.find((p) => p.name === 'broken-profile');
    expect(broken).toBeDefined();
    expect(broken!.running).toBe(false);
    // `running: false` never stands alone — it comes with the reason.
    expect(broken!.unavailable).toBeTruthy();
    expect(broken!.tasks).toEqual([]);
  });
});
