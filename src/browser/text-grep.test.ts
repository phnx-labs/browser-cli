import { describe, expect, it } from 'bun:test';
import { grepText } from './text-grep.js';

const page = ['Cart', 'Item total: $17.98', 'Tax: $1.44', 'Total: $19.42', 'Finish', 'Cancel', 'Footer', 'Total visits: 3'].join('\n');

describe('grepText', () => {
  it('keeps matches with context and separates distant blocks', () => {
    expect(grepText(page, '^total', 1).lines).toEqual(['Tax: $1.44', 'Total: $19.42', 'Finish', '--', 'Footer', 'Total visits: 3']);
  });
  it('merges overlapping context into one block', () => {
    expect(grepText(page, 'total', 1)).toEqual({
      lines: ['Cart', 'Item total: $17.98', 'Tax: $1.44', 'Total: $19.42', 'Finish', '--', 'Footer', 'Total visits: 3'],
      matched: 3,
    });
    expect(grepText(page, 'total', 0).lines).toEqual(['Item total: $17.98', '--', 'Total: $19.42', '--', 'Total visits: 3']);
  });
  it('treats a pattern that is not a regular expression as text', () => {
    expect(grepText('Population (2022 census\n3,121,707', 'Population (2022', 1).lines).toEqual(['Population (2022 census', '3,121,707']);
  });
  it('falls back to the literal text when the expression matches no line', () => {
    expect(grepText(page, '$19.42', 0).lines).toEqual(['Total: $19.42']);
  });
  it('reports no match', () => {
    expect(grepText(page, 'refund')).toEqual({ lines: [], matched: 0 });
  });
});
