/**
 * The `--since`/`--until` grammar of sessions-cli's `parseTimeFilter`, except an
 * unparseable value throws, so a typo fails loud instead of widening to all time.
 */

/** Epoch milliseconds for a relative (`30m`, `2h`, `7d`, `4w`, `1mo`, `1y`) or ISO time. */
export function parseTimeFilter(input: string): number {
  // Units: m=minute, h=hour, d=day, w=week, mo=month(30d), y=year(365d). `mo`
  // must precede the single-letter alternatives so "1mo" isn't read as "1m"+"o".
  const relativeMatch = input.trim().match(/^(\d+)(mo|[mhdwy])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === 'm') return Date.now() - value * 60_000;
    if (unit === 'h') return Date.now() - value * 3_600_000;
    if (unit === 'd') return Date.now() - value * 86_400_000;
    if (unit === 'w') return Date.now() - value * 7 * 86_400_000;
    if (unit === 'mo') return Date.now() - value * 30 * 86_400_000;
    if (unit === 'y') return Date.now() - value * 365 * 86_400_000;
  }
  const ts = new Date(input).getTime();
  if (!input.trim() || Number.isNaN(ts)) throw new Error(`"${input}" is not a time`);
  return ts;
}

/**
 * Parse a command's `--since` / `--until` into a window. Throws with the exact
 * message computer-cli prints, so both tools fail the same way.
 */
export function parseTimeWindow(opts: { since?: string; until?: string }): TimeWindow {
  const bound = (flag: 'since' | 'until', value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    try { return parseTimeFilter(value); } catch {
      throw new Error(`Invalid --${flag} value "${value}": use a relative age (2h, 7d, 4w, 1mo, 1y) or an ISO date.`);
    }
  };
  return { sinceMs: bound('since', opts.since), untilMs: bound('until', opts.until) };
}

/** An inclusive last-activity window; an absent bound is open. */
export interface TimeWindow {
  sinceMs?: number;
  untilMs?: number;
}

export function inTimeWindow(ms: number, window: TimeWindow): boolean {
  return (window.sinceMs === undefined || ms >= window.sinceMs)
    && (window.untilMs === undefined || ms <= window.untilMs);
}
