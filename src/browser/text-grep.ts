/**
 * `browser text --grep`, grep-style, since a harness allowing only `browser` asks before
 * a pipe. Case-insensitive regex, or literal text if it fails to compile or match.
 */
export function grepText(text: string, pattern: string, context = 2): { lines: string[]; matched: number } {
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
  let matched = 0;
  all.forEach((line, i) => {
    if (!regex.test(line)) return;
    matched++;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep.add(j);
  });
  const lines: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) lines.push('--');
    lines.push(all[i]!);
    last = i;
  }
  return { lines, matched };
}
