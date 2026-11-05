#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const COMMENT_TARGET = 2957;

export type CommentKind = 'block' | 'doc' | 'hash' | 'line' | 'xml';

export interface CommentToken {
  start: number;
  end: number;
  from: number;
  to: number;
  kind: CommentKind;
  directive: boolean;
}

export interface ProseViolation {
  path: string;
  startLine: number;
  endLine: number;
  lines: number;
  text: string;
}

export interface FileComments {
  path: string;
  language: string;
  lines: number;
  directives: number;
  tokens: CommentToken[];
}

export interface CommentReport {
  schema: 'comment-lines-v1';
  total: number;
  target: number;
  remaining: number;
  directives: number;
  violations: ProseViolation[];
  files: FileComments[];
}

interface Budget {
  schema: 'comment-budget-v1';
  target: number;
  ceiling: number;
}

type SlashMode = 'code' | 'double' | 'jsx-tag' | 'jsx-text' | 'regex' | 'single' | 'template';

const DIRECTIVE = /(?:@ts-|biome-ignore|cspell:|deno-lint-ignore|eslint-|istanbul ignore|noqa|prettier-ignore|shellcheck|swift-tools-version|type:\s*ignore|vite-ignore|webpackIgnore)/i;
const CODE_EXTENSIONS = new Map<string, string>([
  ['.bash', 'shell'],
  ['.c', 'c'],
  ['.cjs', 'javascript'],
  ['.cs', 'csharp'],
  ['.csproj', 'xml'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.plist', 'xml'],
  ['.py', 'python'],
  ['.scss', 'css'],
  ['.sh', 'shell'],
  ['.swift', 'swift'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.zsh', 'shell'],
]);
const IGNORED_EXTENSIONS = new Set([
  '.after', '.b64', '.before', '.err', '.gif', '.ini', '.jpg', '.jpeg', '.json', '.jsonl',
  '.lock', '.log', '.md', '.mp3', '.mp4', '.ndjson', '.pdf', '.png', '.provisionprofile',
  '.sql', '.stderr', '.stdout', '.svg', '.tgz', '.tsv', '.txt', '.webp',
]);
const IGNORED_BASENAMES = new Set([
  '.gitkeep', '.prettierrc', 'LICENSE', 'Local State', 'SHA256SUMS',
]);
const IGNORED_PREFIXES = ['.agents/', 'docs/'];

let indexedSource = '';
let indexedLines: number[] = [];

function lineAt(source: string, offset: number): number {
  if (source !== indexedSource) {
    indexedSource = source;
    indexedLines = [0];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) indexedLines.push(i + 1);
  }
  let low = 0;
  let high = indexedLines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (indexedLines[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function token(source: string, start: number, end: number, kind: CommentKind): CommentToken {
  return {
    start: lineAt(source, start),
    end: lineAt(source, Math.max(start, end - 1)),
    from: start,
    to: end,
    kind,
    directive: DIRECTIVE.test(source.slice(start, end)),
  };
}

function skipQuoted(source: string, offset: number, quote: string): number {
  for (let i = offset + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote || source[i] === '\n') return i;
  }
  return source.length - 1;
}

function shifted(tokens: CommentToken[], source: string, offset: number): CommentToken[] {
  const lineOffset = lineAt(source, offset) - 1;
  return tokens.map((item) => ({
    ...item,
    start: item.start + lineOffset,
    end: item.end + lineOffset,
    from: item.from + offset,
    to: item.to + offset,
  }));
}

function embeddedLanguage(shebang: string): string | null {
  if (/\bpython(?:3)?\b/.test(shebang)) return 'python';
  if (/\b(?:node|bun|deno)\b/.test(shebang)) return 'javascript';
  if (/\b(?:ba|z|da)?sh\b/.test(shebang)) return 'shell';
  return null;
}

function embeddedTemplateComments(
  source: string,
  start: number,
  end: number,
  holes: Array<[number, number]>,
): CommentToken[] {
  const raw = source.slice(start, end);
  const taggedRaw = /String\.raw\s*`$/.test(source.slice(Math.max(0, start - 32), start));
  if (!raw.startsWith('#!') && !taggedRaw) return [];
  const language = raw.startsWith('#!')
    ? embeddedLanguage(raw.split(/\r?\n|\\n/, 1)[0])
    : (/^\s*\$[A-Za-z_]/.test(raw) ? 'toml' : 'javascript');
  if (!language) return [];
  const masked = [...raw];
  for (const [holeStart, holeEnd] of holes) {
    for (let i = Math.max(start, holeStart); i < Math.min(end, holeEnd); i++) {
      const local = i - start;
      if (masked[local] !== '\n' && masked[local] !== '\r') masked[local] = ' ';
    }
  }
  const body = masked.join('');
  if (!body.includes('\n') && body.includes('\\n')) {
    const virtual = body.replace(/\\n/g, '\n');
    const tokens = scanSource(virtual, language);
    if (!tokens.length) return [];
    return [token(source, start, end, tokens.some((item) => item.directive) ? 'line' : tokens[0].kind)];
  }
  return shifted(scanSource(body, language), source, start);
}

function slashComments(source: string, jsx: boolean): CommentToken[] {
  const out: CommentToken[] = [];
  const contexts: Array<{
    kind: 'jsx' | 'template';
    depth: number;
    back: SlashMode;
    holeStart?: number;
    template?: { start: number; holes: Array<[number, number]> };
  }> = [];
  const templates: Array<{ start: number; holes: Array<[number, number]> }> = [];
  let mode: SlashMode = 'code';
  let canRegex = true;
  let jsxDepth = 0;
  const jsxBases: number[] = [];
  let closingTag = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'single' || mode === 'double') {
      if (ch === '\\') i++;
      else if (ch === (mode === 'single' ? "'" : '"') || ch === '\n') mode = 'code';
      continue;
    }
    if (mode === 'regex') {
      let inClass = false;
      for (; i < source.length; i++) {
        if (source[i] === '\\') i++;
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) {
          while (/[a-z]/i.test(source[i + 1] ?? '')) i++;
          mode = 'code';
          canRegex = false;
          break;
        } else if (source[i] === '\n') {
          mode = 'code';
          break;
        }
      }
      continue;
    }
    if (mode === 'template') {
      if (ch === '\\') i++;
      else if (ch === '`') {
        const current = templates.pop();
        if (current) out.push(...embeddedTemplateComments(source, current.start, i, current.holes));
        mode = 'code';
        canRegex = false;
      } else if (ch === '$' && next === '{') {
        const current = templates.at(-1);
        contexts.push({ kind: 'template', depth: 1, back: 'template', holeStart: i, template: current });
        mode = 'code';
        canRegex = true;
        i++;
      }
      continue;
    }
    if (mode === 'jsx-text') {
      if (ch === '{') {
        contexts.push({ kind: 'jsx', depth: 1, back: 'jsx-text' });
        mode = 'code';
        canRegex = true;
      } else if (ch === '<') {
        closingTag = next === '/';
        mode = 'jsx-tag';
        if (closingTag) i++;
      }
      continue;
    }
    if (mode === 'jsx-tag') {
      if (ch === "'" || ch === '"') i = skipQuoted(source, i, ch);
      else if (ch === '{') {
        contexts.push({ kind: 'jsx', depth: 1, back: 'jsx-tag' });
        mode = 'code';
        canRegex = true;
      } else if (ch === '>') {
        const selfClosing = source[i - 1] === '/';
        if (closingTag) jsxDepth--;
        else if (!selfClosing) jsxDepth++;
        const base = jsxBases.at(-1);
        const completesRoot = base !== undefined
          && ((closingTag && jsxDepth === base) || (selfClosing && jsxDepth === base));
        closingTag = false;
        if (completesRoot) {
          jsxBases.pop();
          mode = 'code';
        } else mode = jsxDepth > 0 ? 'jsx-text' : 'code';
        canRegex = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      out.push(token(source, start, i, 'line'));
      canRegex = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length - 1, i + 1);
      out.push(token(source, start, i + 1, source[start + 2] === '*' ? 'doc' : 'block'));
      continue;
    }
    if (ch === "'" || ch === '"') {
      mode = ch === "'" ? 'single' : 'double';
      continue;
    }
    if (ch === '`') {
      templates.push({ start: i + 1, holes: [] });
      mode = 'template';
      continue;
    }
    if (jsx && ch === '<' && /[A-Za-z>/]/.test(next ?? '')) {
      jsxBases.push(jsxDepth);
      closingTag = next === '/';
      mode = 'jsx-tag';
      if (closingTag) i++;
      continue;
    }
    if (ch === '/' && canRegex) {
      mode = 'regex';
      continue;
    }
    if (ch === '{') {
      if (contexts.length) contexts.at(-1)!.depth++;
      canRegex = true;
      continue;
    }
    if (ch === '}') {
      const context = contexts.at(-1);
      if (context && --context.depth === 0) {
        contexts.pop();
        if (context.template && context.holeStart !== undefined) context.template.holes.push([context.holeStart, i + 1]);
        mode = context.back;
      }
      canRegex = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (/[\w$]/.test(source[i + 1] ?? '')) i++;
      const word = source.slice(start, i + 1);
      canRegex = /^(?:case|delete|do|else|in|instanceof|new|return|throw|typeof|void|yield)$/.test(word);
      continue;
    }
    if (/[0-9]/.test(ch) || /[)\]]/.test(ch)) {
      canRegex = false;
      continue;
    }
    if (/[,;:([=!&|?+*%~^-]/.test(ch)) canRegex = true;
  }
  return out;
}

function nativeComments(source: string, language: 'c' | 'csharp' | 'swift'): CommentToken[] {
  const out: CommentToken[] = [];

  function skipEscapedString(offset: number, quote: string): number {
    for (let i = offset + 1; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === quote) return i;
    }
    return source.length - 1;
  }

  function skipRepeatedQuote(offset: number, width: number, suffix = ''): number {
    const close = '"'.repeat(width) + suffix;
    const end = source.indexOf(close, offset + width);
    return end < 0 ? source.length - 1 : end + close.length - 1;
  }

  function skipBlock(offset: number): number {
    let depth = 1;
    for (let i = offset + 2; i < source.length; i++) {
      if (language === 'swift' && source[i] === '/' && source[i + 1] === '*') {
        depth++;
        i++;
      } else if (source[i] === '*' && source[i + 1] === '/') {
        if (--depth === 0) return i + 1;
        i++;
      }
    }
    return source.length - 1;
  }

  function skipLiteral(offset: number): number {
    if (language === 'csharp' && source[offset] === '@' && source[offset + 1] === '"') {
      for (let i = offset + 2; i < source.length; i++) {
        if (source[i] === '"' && source[i + 1] === '"') i++;
        else if (source[i] === '"') return i;
      }
      return source.length - 1;
    }
    if (language === 'swift' && (source[offset] === '#' || source[offset] === '"')) {
      let hashes = 0;
      while (source[offset + hashes] === '#') hashes++;
      const quoteAt = offset + hashes;
      if (source[quoteAt] === '"') {
        const width = source.slice(quoteAt, quoteAt + 3) === '"""' ? 3 : 1;
        return skipRepeatedQuote(quoteAt, width, '#'.repeat(hashes));
      }
    }
    if (source[offset] === '"') {
      let width = 1;
      while (source[offset + width] === '"') width++;
      return width >= 3 ? skipRepeatedQuote(offset, width) : skipEscapedString(offset, '"');
    }
    return skipEscapedString(offset, source[offset]);
  }

  function balancedEnd(openAt: number, open: string, close: string): number {
    let depth = 1;
    for (let i = openAt + 1; i < source.length; i++) {
      if (source[i] === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++;
      } else if (source[i] === '/' && source[i + 1] === '*') {
        i = skipBlock(i);
      } else if (source[i] === '"' || source[i] === "'" || (language === 'swift' && source[i] === '#') || (language === 'csharp' && source[i] === '@')) {
        i = skipLiteral(i);
      } else if (source[i] === open) {
        depth++;
      } else if (source[i] === close && --depth === 0) {
        return i;
      }
    }
    return source.length;
  }

  function scanExpression(start: number, end: number): void {
    if (end <= start) return;
    out.push(...shifted(nativeComments(source.slice(start, end), language), source, start));
  }

  function scanSwiftString(quoteAt: number, hashes: number, width: number): number {
    const close = '"'.repeat(width) + '#'.repeat(hashes);
    const interpolation = `\\${'#'.repeat(hashes)}(`;
    for (let i = quoteAt + width; i < source.length;) {
      if (source.startsWith(close, i)) return i + close.length - 1;
      if (source.startsWith(interpolation, i)) {
        const openAt = i + interpolation.length - 1;
        const end = balancedEnd(openAt, '(', ')');
        scanExpression(openAt + 1, end);
        i = end < source.length ? end + 1 : source.length;
        continue;
      }
      if (hashes === 0 && source[i] === '\\') i += 2;
      else i++;
    }
    return source.length - 1;
  }

  function scanCSharpString(quoteAt: number, width: number, verbatim: boolean, braces: number): number {
    const close = '"'.repeat(width);
    const interpolation = '{'.repeat(braces);
    for (let i = quoteAt + width; i < source.length;) {
      if (source.startsWith(close, i)) {
        if (verbatim && width === 1 && source[i + 1] === '"') {
          i += 2;
          continue;
        }
        return i + width - 1;
      }
      if (width === 1 && braces === 1 && (source.startsWith('{{', i) || source.startsWith('}}', i))) {
        i += 2;
        continue;
      }
      if (source.startsWith(interpolation, i) && (width >= 3 || source[i + braces] !== '{')) {
        const openAt = i + braces - 1;
        const end = balancedEnd(openAt, '{', '}');
        scanExpression(openAt + 1, end);
        i = end < source.length ? end + braces : source.length;
        continue;
      }
      if (!verbatim && width === 1 && source[i] === '\\') i += 2;
      else i++;
    }
    return source.length - 1;
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      out.push(token(source, start, i, 'line'));
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (language === 'swift' && source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out.push(token(source, start, i, source[start + 2] === '*' ? 'doc' : 'block'));
      i--;
      continue;
    }
    if (language === 'csharp' && ch === '@' && next === '"') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') i += 2;
        else if (source[i] === '"') break;
        else i++;
      }
      continue;
    }
    if (language === 'csharp' && (ch === '$' || (ch === '@' && next === '$'))) {
      const prefixStart = i;
      let at = i;
      let verbatim = false;
      if (source[at] === '@') {
        verbatim = true;
        at++;
      }
      let dollars = 0;
      while (source[at] === '$') {
        dollars++;
        at++;
      }
      if (source[at] === '@') {
        verbatim = true;
        at++;
      }
      if (dollars > 0 && source[at] === '"') {
        let width = 1;
        while (source[at + width] === '"') width++;
        i = scanCSharpString(at, width, verbatim, width >= 3 ? dollars : 1);
        continue;
      }
      i = prefixStart;
    }
    if (language === 'csharp' && ch === '"') {
      let width = 1;
      while (source[i + width] === '"') width++;
      if (width >= 3) i = skipRepeatedQuote(i, width);
      else i = skipEscapedString(i, '"');
      continue;
    }
    if (language === 'swift' && (ch === '#' || ch === '"')) {
      let hashes = 0;
      while (source[i + hashes] === '#') hashes++;
      const quoteAt = i + hashes;
      if (source[quoteAt] === '"') {
        const width = source.slice(quoteAt, quoteAt + 3) === '"""' ? 3 : 1;
        i = scanSwiftString(quoteAt, hashes, width);
        continue;
      }
    }
    if (ch === '"' || ch === "'") i = skipEscapedString(i, ch);
  }
  return out;
}

function cssComments(source: string): CommentToken[] {
  const out: CommentToken[] = [];
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length - 1, i + 1);
      out.push(token(source, start, i + 1, 'block'));
    }
  }
  return out;
}

function heredocLanguage(command: string, delimiter: string): string | null {
  if (/\bpython(?:3)?\b/.test(command) || /^(?:PY|PYTHON)$/.test(delimiter)) return 'python';
  if (/\b(?:node|bun|deno)\b/.test(command) || /^(?:JS|JAVASCRIPT|NODE)$/.test(delimiter)) return 'javascript';
  if (/\b(?:ba|z|da)?sh\b/.test(command) || /^(?:SH|SHELL|BASH|BOOTSTRAP|REMOTE_EOF|SNIPPET)$/.test(delimiter)) return 'shell';
  if (/^(?:UNIT|SERVICE)$/.test(delimiter)) return 'toml';
  return null;
}

function hashComments(source: string, language: 'python' | 'shell' | 'toml' | 'yaml'): CommentToken[] {
  const out: CommentToken[] = [];
  let quote = '';
  let shellAnsiQuote = false;
  let triple = '';
  let blockIndent: number | null = null;
  let heredoc: { delimiter: string; stripTabs: boolean; language: string | null; start: number; body: string } | null = null;
  let offset = 0;

  for (const raw of source.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    if (language === 'shell' && heredoc) {
      const marker = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (marker === heredoc.delimiter) {
        if (heredoc.language) out.push(...shifted(scanSource(heredoc.body, heredoc.language), source, heredoc.start));
        heredoc = null;
      } else heredoc.body += raw;
      offset += raw.length;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (language === 'yaml' && blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        offset += raw.length;
        continue;
      }
      blockIndent = null;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (triple) {
        if (line.slice(i, i + 3) === triple) {
          i += 2;
          triple = '';
        } else if (ch === '\\' && triple === '"""') i++;
        continue;
      }
      if (quote) {
        if (ch === '\\' && (quote === '"' || language === 'python' || shellAnsiQuote)) i++;
        else if (ch === quote) {
          quote = '';
          shellAnsiQuote = false;
        }
        continue;
      }
      if ((language === 'python' || language === 'toml') && (line.slice(i, i + 3) === "'''" || line.slice(i, i + 3) === '"""')) {
        triple = line.slice(i, i + 3);
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        shellAnsiQuote = language === 'shell' && ch === "'" && line[i - 1] === '$';
        continue;
      }
      if (language === 'shell' && ch === '\\') {
        i++;
        continue;
      }
      if (ch !== '#') continue;
      if (i === 0 && offset === 0 && line.startsWith('#!')) break;
      if (language === 'shell') {
        const prev = line[i - 1] ?? '';
        if (prev && !/[\s;|&()]/.test(prev)) continue;
      }
      if (language === 'yaml' && i > 0 && !/\s/.test(line[i - 1])) continue;
      out.push(token(source, offset + i, offset + line.length, 'hash'));
      break;
    }
    if (language === 'yaml' && /(?:^|:\s*|-\s+)[|>](?:[+-]?[1-9]?|[1-9][+-]?)?\s*(?:#.*)?$/.test(line)) blockIndent = indent;
    if (language === 'shell') {
      const match = line.match(/(?<!<)<<(-)?(?!<)\s*(?:(['"])([^'"]+)\2|([A-Za-z_][\w-]*))/);
      if (match) {
        const delimiter = match[3] ?? match[4];
        heredoc = {
          delimiter,
          stripTabs: Boolean(match[1]),
          language: heredocLanguage(line.slice(0, match.index), delimiter),
          start: offset + raw.length,
          body: '',
        };
      }
    }
    offset += raw.length;
  }
  if (heredoc?.language) out.push(...shifted(scanSource(heredoc.body, heredoc.language), source, heredoc.start));
  return out;
}

function xmlComments(source: string): CommentToken[] {
  const out: CommentToken[] = [];
  let at = 0;
  while ((at = source.indexOf('<!--', at)) >= 0) {
    const end = source.indexOf('-->', at + 4);
    const stop = end < 0 ? source.length : end + 3;
    out.push(token(source, at, stop, 'xml'));
    at = stop;
  }
  return out;
}

function htmlComments(source: string): CommentToken[] {
  const out = xmlComments(source);
  const embedded = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of source.matchAll(embedded)) {
    const body = match[2];
    const offset = (match.index ?? 0) + match[0].indexOf(body);
    out.push(...shifted(scanSource(body, match[1].toLowerCase() === 'style' ? 'css' : 'javascript'), source, offset));
  }
  return out;
}

export function classifyPath(path: string, source?: string): string | null {
  if (IGNORED_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  const name = basename(path);
  if (name.startsWith('Dockerfile')) return 'shell';
  if (name === 'Makefile' || name === 'CODEOWNERS' || name === '.gitignore' || name === '.npmignore') return 'shell';
  const language = CODE_EXTENSIONS.get(extname(name).toLowerCase());
  if (language) return language;
  if (!extname(name) && source?.startsWith('#!')) return 'shell';
  if (IGNORED_BASENAMES.has(name) || IGNORED_EXTENSIONS.has(extname(name).toLowerCase())) return null;
  throw new Error(`unclassified tracked file: ${path}`);
}

export function scanSource(source: string, language: string): CommentToken[] {
  switch (language) {
    case 'typescript':
    case 'javascript': return slashComments(source, false);
    case 'css': return cssComments(source);
    case 'tsx':
    case 'jsx': return slashComments(source, true);
    case 'c': return nativeComments(source, 'c');
    case 'csharp': return nativeComments(source, 'csharp');
    case 'swift': return nativeComments(source, 'swift');
    case 'python': return hashComments(source, 'python');
    case 'shell': return hashComments(source, 'shell');
    case 'toml': return hashComments(source, 'toml');
    case 'yaml': return hashComments(source, 'yaml');
    case 'html': return htmlComments(source);
    case 'xml': return xmlComments(source);
    default: throw new Error(`unsupported comment language: ${language}`);
  }
}

const LICENSE_RE = /\b(?:copyright|spdx-license|apache license|all rights reserved|mozilla public)\b/i;
const DIRECTIVE_RE = /^\s*(?:\/\/|\/\*|\*|#)\s*(?:go:build|\+build|nolint|eslint-|@ts-|@jsx|cgo:|go:generate|go:linkname|biome-ignore|prettier-ignore|shellcheck|swift-tools-version)/i;
const CODEISH_RE = /^\s*(?:\/\/|\/\*|\*|#)?\s*(?:(?:if|for|switch|while|catch)\s*\([^)]*\)\s*[{;]|for\s*\(\s*(?:const|let|var)\b|(?:function|func)\s*(?:[A-Za-z_$][\w$]*\s*)?\([^)]*\)\s*\{|class\s+[A-Za-z_$][\w$]*\s*(?:extends\s+[^{]+)?\{|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*[=:{;]|import\s+(?:["'*{]|type\b|[A-Za-z_$][\w$]*\s+from\b)|type\s+[A-Za-z_$]+\s*(?:=|struct|interface)|return\b[^;\n]*;|[{}();]+\s*$)/;

function proseViolations(path: string, source: string, tokens: CommentToken[]): ProseViolation[] {
  function exempt(body: string): boolean {
    const nonempty = body.split('\n').filter((line) => line.trim());
    if (LICENSE_RE.test(body)) return true;
    if (nonempty.length && nonempty.every((line) => DIRECTIVE_RE.test(line))) return true;
    return Boolean(nonempty.length && nonempty.filter((line) => CODEISH_RE.test(line)).length / nonempty.length >= 0.5);
  }

  const found: ProseViolation[] = [];
  for (const item of tokens) {
    const lines = item.end - item.start + 1;
    const body = source.slice(item.from, item.to);
    if (lines > 4 && !exempt(body)) {
      found.push({ path, startLine: item.start, endLine: item.end, lines, text: body });
    }
  }

  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const commentOnly: Array<{ text: string } | null> = [];
  for (let line = 0; line < starts.length; line++) {
    const start = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : source.length;
    const covering = tokens.filter((item) => item.start <= line + 1 && item.end >= line + 1);
    if (!covering.length) {
      commentOnly.push(null);
      continue;
    }
    const segments = covering.map((item) => ({
      from: Math.max(start, item.from),
      to: Math.min(end, item.to),
    })).sort((a, b) => a.from - b.from);
    let cursor = start;
    let code = '';
    let text = '';
    for (const segment of segments) {
      if (segment.from > cursor) code += source.slice(cursor, segment.from);
      if (segment.to > segment.from) text += source.slice(segment.from, segment.to);
      cursor = Math.max(cursor, segment.to);
    }
    if (cursor < end) code += source.slice(cursor, end);
    commentOnly.push(code.trim() ? null : { text });
  }

  for (let i = 0; i < commentOnly.length;) {
    if (!commentOnly[i]) {
      i++;
      continue;
    }
    const start = i;
    const text: string[] = [];
    while (i < commentOnly.length && commentOnly[i]) text.push(commentOnly[i++]!.text);
    if (i - start <= 4) continue;
    const body = text.join('\n');
    if (exempt(body)) continue;
    if (!found.some((item) => item.startLine === start + 1 && item.endLine === i)) {
      found.push({ path, startLine: start + 1, endLine: i, lines: i - start, text: body });
    }
  }
  return found;
}

function gitFiles(repoRoot: string): string[] {
  const proc = Bun.spawnSync({ cmd: ['git', 'ls-files', '-z'], cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(Buffer.from(proc.stderr).toString('utf8').trim());
  return Buffer.from(proc.stdout).toString('utf8').split('\0').filter(Boolean).sort();
}

export function scanRepository(repoRoot: string): CommentReport {
  const files: FileComments[] = [];
  const violations: ProseViolation[] = [];
  let total = 0;
  let directives = 0;
  for (const path of gitFiles(repoRoot)) {
    const absolute = join(repoRoot, path);
    let source = '';
    try {
      source = readFileSync(absolute, 'utf8');
    } catch {
      if (!IGNORED_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error(`cannot read tracked file: ${path}`);
      continue;
    }
    const language = classifyPath(path, source);
    if (!language) continue;
    const tokens = scanSource(source, language);
    const hitLines = new Set<number>();
    for (const item of tokens) for (let line = item.start; line <= item.end; line++) hitLines.add(line);
    const directiveLines = new Set(tokens.filter((item) => item.directive).flatMap((item) => {
      const lines: number[] = [];
      for (let line = item.start; line <= item.end; line++) lines.push(line);
      return lines;
    }));
    if (!hitLines.size) continue;
    violations.push(...proseViolations(path, source, tokens));
    total += hitLines.size;
    directives += directiveLines.size;
    files.push({ path, language, lines: hitLines.size, directives: directiveLines.size, tokens });
  }
  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  violations.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);
  return { schema: 'comment-lines-v1', total, target: COMMENT_TARGET, remaining: Math.max(0, total - COMMENT_TARGET), directives, violations, files };
}

function loadBudget(text: string, label: string): Budget {
  const value = JSON.parse(text) as Budget;
  if (value.schema !== 'comment-budget-v1' || value.target !== COMMENT_TARGET || !Number.isSafeInteger(value.ceiling) || value.ceiling < 0) {
    throw new Error(`invalid ${label}: expected comment-budget-v1, target ${COMMENT_TARGET}, and a non-negative integer ceiling`);
  }
  return value;
}

function gitShow(repoRoot: string, ref: string, path: string): string | null {
  const commit = Bun.spawnSync({ cmd: ['git', 'cat-file', '-e', `${ref}^{commit}`], cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (commit.exitCode !== 0) throw new Error(`cannot read base commit ${ref}; fetch it before running --check --base`);
  const proc = Bun.spawnSync({ cmd: ['git', 'show', `${ref}:${path}`], cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  return proc.exitCode === 0 ? Buffer.from(proc.stdout).toString('utf8') : null;
}

function parseArgs(argv: string[]): { base?: string; check: boolean; json: boolean; ndjson: boolean } {
  const result: ReturnType<typeof parseArgs> = { check: false, json: false, ndjson: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') result.base = argv[++i];
    else if (argv[i] === '--check') result.check = true;
    else if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--ndjson') result.ndjson = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return result;
}

function repoRoot(cwd = process.cwd()): string {
  const proc = Bun.spawnSync({ cmd: ['git', 'rev-parse', '--show-toplevel'], cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error('comment-lines must run inside a git worktree');
  return Buffer.from(proc.stdout).toString('utf8').trim();
}

export function checkBudget(repo: string, report: CommentReport, base?: string): Budget {
  const path = 'scripts/comment-budget.json';
  const current = loadBudget(readFileSync(join(repo, path), 'utf8'), path);
  if (report.total > COMMENT_TARGET) throw new Error(`comment total ${report.total} exceeds target ${COMMENT_TARGET}`);
  if (report.total !== current.ceiling) throw new Error(`comment total ${report.total} does not equal recorded ceiling ${current.ceiling}; set ceiling to the exact total`);
  if (report.violations.length) {
    const details = report.violations.map((item) => `${item.path}:${item.startLine} (${item.lines} lines)`).join('\n');
    throw new Error(`${report.violations.length} prose comment block(s) exceed four lines:\n${details}`);
  }
  if (base) {
    const previousText = gitShow(repo, base, path);
    if (previousText) {
      const previous = loadBudget(previousText, `${base}:${path}`);
      if (current.ceiling > previous.ceiling) throw new Error(`comment ceiling increased from ${previous.ceiling} to ${current.ceiling}`);
      if (current.target !== previous.target) throw new Error(`comment target changed from ${previous.target} to ${current.target}`);
    }
  }
  return current;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = repoRoot();
  const report = scanRepository(repo);
  if (args.check) checkBudget(repo, report, args.base);
  if (args.ndjson) {
    for (const file of report.files) for (const item of file.tokens) console.log(JSON.stringify({ path: file.path, ...item }));
  } else if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.total} comment lines; target ${report.target}; ${report.remaining} remaining; ${report.directives} directive lines; ${report.violations.length} long prose blocks`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
