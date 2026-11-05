import {
  runBrowserSessions,
  listBrowserSessions,
  filterArtifactGroups,
  buildBrowserSessionRows,
  matchesBrowserSessionRow,
  type BrowserSessionRow,
  type BrowserArtifact,
} from '../browser/sessions-list.js';
import {
  formatBytes,
  formatRelativeTime,
  isInteractiveTerminal,
  isPromptCancelled,
  itemPicker,
  parseLimit,
  printJson,
  printLine,
  printList,
  writeErr,
} from '@phnx-labs/tui';
import { showFile } from '../runtime/open-url.js';
import { inTimeWindow, parseTimeWindow, type TimeWindow } from '../runtime/time-filter.js';

export interface BrowserSessionsCommandOpts {
  profile?: string;
  open?: string | boolean;
  json?: boolean;
  interactive?: boolean;
  tasks?: boolean;
  search?: string;
  since?: string;
  until?: string;
  /** Raw `--limit`; validated here so a bad value exits 2 like a bad window. */
  limit?: string;
}

export function shouldOpenInteractiveBrowserSessions(opts: BrowserSessionsCommandOpts, isTTY: boolean): boolean {
  return Boolean(isTTY && !opts.json && opts.open === undefined && opts.interactive !== false);
}

/** The picker header: `Browser history (since 7d · until 2026-10-01 · search "x"):`. */
export function pickerHeader(opts: BrowserSessionsCommandOpts): string {
  const active = [
    opts.since !== undefined && `since ${opts.since}`,
    opts.until !== undefined && `until ${opts.until}`,
    opts.profile !== undefined && `profile ${opts.profile}`,
    opts.search && `search "${opts.search}"`,
  ].filter(Boolean);
  return active.length ? `Browser history (${active.join(' · ')}):` : 'Browser history:';
}

export async function runBrowserSessionsCommand(opts: BrowserSessionsCommandOpts): Promise<void> {
  let window: TimeWindow;
  let limit: number | undefined;
  try {
    window = parseTimeWindow(opts);
    limit = parseLimit(opts.limit);
  } catch (error) {
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const interactive = shouldOpenInteractiveBrowserSessions(opts, isInteractiveTerminal());
  if (!interactive && !opts.tasks && !opts.search) {
    const groups = filterArtifactGroups(listBrowserSessions(opts.profile), window, opts.profile !== undefined);
    const windowed = window.sinceMs !== undefined || window.untilMs !== undefined;
    if (windowed && !groups.length && !opts.json && opts.open === undefined) {
      printLine('No browser captures match --since/--until.');
      return;
    }
    await runBrowserSessions({ profile: opts.profile, open: opts.open, json: opts.json, limit }, groups);
    return;
  }
  const rows = buildBrowserSessionRows(opts.profile)
    .filter(row => matchesBrowserSessionRow(row, opts.search ?? '') && inTimeWindow(row.latestMtimeMs, window));
  const windowed = window.sinceMs !== undefined || window.untilMs !== undefined;
  if (windowed && !rows.length && !opts.json && opts.open === undefined) {
    printLine('No browser tasks or captures match --since/--until.');
    return;
  }
  if (!interactive) {
    if (opts.open !== undefined) {
      await runBrowserSessions({ profile: opts.profile, open: opts.open, json: opts.json }, rows);
    } else if (opts.json) {
      printJson(limit === undefined ? rows : rows.slice(0, limit));
    } else {
      printList({
        rows, limit, noun: 'task', render: shown => shown.map(rowLabel),
        narrowHint: '--search or --since to narrow', empty: 'No browser tasks or captures found.',
      });
    }
    return;
  }
  if (!rows.length) { printLine('No browser tasks or captures found.'); return; }
  try {
    for (;;) {
      const picked = await itemPicker({
        message: pickerHeader(opts), items: rows,
        filter: query => rows.filter(row => matchesBrowserSessionRow(row, query)),
        labelFor: rowLabel, buildPreview: rowPreview, enterHint: 'browse captures', maxRows: Infinity,
      });
      if (!picked) return;
      const row = picked.item;
      if (!row.artifacts.length) { printLine('No captures saved for this task.'); continue; }
      for (;;) {
        const capture = await itemPicker<BrowserArtifact>({
          message: `Captures — ${row.task ?? 'downloads'} (${row.profile}):`, items: row.artifacts,
          filter: query => row.artifacts.filter(file => file.name.toLowerCase().includes(query.toLowerCase())),
          labelFor: file => `${file.name}  ${formatBytes(file.bytes)}`,
          buildPreview: file => `${file.kind}\n${file.path}\n${formatBytes(file.bytes)}`,
          enterHint: 'open', maxRows: Infinity,
        });
        if (!capture) break;
        printLine(capture.item.path);
        if ((await showFile(capture.item.path)).via === 'none') writeErr(`Could not open ${capture.item.path}\n`);
      }
    }
  } catch (error) {
    if (isPromptCancelled(error)) return;
    throw error;
  }
}

function rowLabel(row: BrowserSessionRow): string {
  return `${row.task ?? 'Downloads'}  ${row.profile}  ${row.artifacts.length} captures  ${formatRelativeTime(new Date(row.latestMtimeMs).toISOString())}`;
}

function rowPreview(row: BrowserSessionRow): string {
  return [row.task ?? 'Downloads', `Profile: ${row.profile}`,
    row.sessionId ? `Conversation reference: ${row.sessionId}` : row.launchId ? `Launch reference: ${row.launchId}` : 'No conversation reference',
    ...row.artifacts.slice(0, 12).map(file => `${file.name}  ${formatBytes(file.bytes)}`),
    !row.artifacts.length ? 'No captures saved yet.' : '',
  ].filter(Boolean).join('\n');
}

export type { BrowserSessionRow };
