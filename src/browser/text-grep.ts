/**
 * `browser text --grep`, grep-style, since a harness allowing only `browser` asks before
 * a pipe. Case-insensitive regex, or literal text if it fails to compile or match.
 */
export function grepText(text: string, pattern: string, context = 2, cutLongLines = true): { lines: string[]; matched: number } {
  const all = text.split('\n');
  const literal = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  let regex = literal;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    // Not a regular expression: match it as text.
  }
  // "$19.42" compiles, with $ as an anchor, and matches nothing; the price was meant.
  if (regex !== literal && !all.some((line) => regex.test(line))) regex = literal;
  const keep = new Set<number>();
  const hits = new Set<number>();
  all.forEach((line, i) => {
    if (!regex.test(line)) return;
    hits.add(i);
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep.add(j);
  });
  const lines: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) lines.push('--');
    const line = all[i]!;
    lines.push(!cutLongLines ? line : hits.has(i) ? aroundMatch(line, regex) : head(line));
    last = i;
  }
  return { lines, matched: hits.size };
}

const MATCH_WINDOW = 240;
const CONTEXT_HEAD = 120;

function aroundMatch(line: string, regex: RegExp): string {
  if (line.length <= MATCH_WINDOW) return line;
  const start = offPair(line, Math.max(0, Math.min(line.search(regex) - MATCH_WINDOW / 2, line.length - MATCH_WINDOW)));
  const end = offPair(line, start + MATCH_WINDOW);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

function head(line: string): string {
  return line.length <= CONTEXT_HEAD ? line : `${line.slice(0, offPair(line, CONTEXT_HEAD))}…`;
}

function offPair(line: string, at: number): number {
  const code = line.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}
