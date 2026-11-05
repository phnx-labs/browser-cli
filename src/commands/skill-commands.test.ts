import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Command } from 'commander';
import { buildProgram } from '../index.js';

const SKILL = join(import.meta.dir, '..', '..', 'skills', 'browser');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : []);
}

/** Every line inside fenced code, plus every inline code span, from a Markdown file. */
function codeLines(text: string): string[] {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'));
  const inline = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  return [...fenced, ...inline];
}

/** Extract browser invocations, removing substitutions checked separately and stopping at shell
 * separators/comments. */
function invocations(line: string): string[][] {
  const out: string[][] = [];
  const subs = [...line.matchAll(/\$\(([^)]*)\)/g)].map((m) => m[1]);
  const flat = line.replace(/\$\([^)]*\)/g, 'SUBST');
  for (const part of [flat, ...subs]) {
    for (const seg of part.split(/\s*(?:\||&&|;|#)\s*/)) {
      const m = seg.match(/(?:^|\s)browser\s+(.*)$/);
      if (m) out.push(m[1].split(/\s+/).filter(Boolean));
    }
  }
  return out;
}

it('every browser command and flag the skill shows exists in the CLI', () => {
  const program = buildProgram();
  const problems: string[] = [];
  for (const file of markdownFiles(SKILL)) {
    for (const line of codeLines(readFileSync(file, 'utf8'))) {
      for (const words of invocations(line)) {
        // Placeholders (`browser <command> --help`) and bare mentions are not invocations.
        if (words.length === 0 || words[0].startsWith('<') || !/^[a-z]/.test(words[0])) continue;
        let cmd: Command = program;
        let i = 0;
        for (; i < words.length; i++) {
          const next = cmd.commands.find((c) => c.name() === words[i] || c.aliases().includes(words[i]));
          if (!next) break;
          cmd = next;
        }
        const where = `${relative(SKILL, file)}: browser ${words.join(' ')}`;
        if (cmd === program) {
          problems.push(`${where} — unknown command "${words[0]}"`);
          continue;
        }
        const longs = new Set(cmd.options.map((o) => o.long).concat(['--help']));
        const shorts = new Set(cmd.options.map((o) => o.short).filter(Boolean).concat(['-h']));
        for (const w of words.slice(i)) {
          const flag = w.split('=')[0];
          if (flag.startsWith('--') && !longs.has(flag)) problems.push(`${where} — ${cmd.name()} has no ${flag}`);
          else if (/^-[a-zA-Z]$/.test(flag) && !shorts.has(flag)) problems.push(`${where} — ${cmd.name()} has no ${flag}`);
        }
      }
    }
  }
  expect(problems).toEqual([]);
});
