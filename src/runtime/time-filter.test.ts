import { expect, it } from 'bun:test';
import { parseTimeFilter, parseTimeWindow, inTimeWindow } from './time-filter.js';

it('reads the sessions grammar, including 1mo as a month rather than a minute', () => {
  const now = Date.now();
  const near = (ms: number, expected: number) => expect(Math.abs(ms - expected)).toBeLessThan(5_000);
  near(parseTimeFilter('30m'), now - 30 * 60_000);
  near(parseTimeFilter('2h'), now - 2 * 3_600_000);
  near(parseTimeFilter('7d'), now - 7 * 86_400_000);
  near(parseTimeFilter('4w'), now - 28 * 86_400_000);
  near(parseTimeFilter('1mo'), now - 30 * 86_400_000);
  near(parseTimeFilter('1Y'), now - 365 * 86_400_000);
  expect(parseTimeFilter('2026-10-01')).toBe(Date.parse('2026-10-01'));
});

it('rejects a typo instead of widening the window to all time', () => {
  for (const bad of ['7days', 'yesterday', '', '-2h']) expect(() => parseTimeFilter(bad)).toThrow();
  expect(() => parseTimeWindow({ until: 'soon' })).toThrow('Invalid --until value "soon": use a relative age (2h, 7d, 4w, 1mo, 1y) or an ISO date.');
});

it('keeps both bounds inclusive', () => {
  expect(inTimeWindow(100, { sinceMs: 100, untilMs: 100 })).toBe(true);
  expect(inTimeWindow(99, { sinceMs: 100 })).toBe(false);
  expect(inTimeWindow(101, { untilMs: 100 })).toBe(false);
});
