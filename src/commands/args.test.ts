import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { intOption, pointArgument, refArgument } from './args.js';
import { ipcEndpoint } from '../runtime/platform.js';
import { version } from '../version.js';

const entry = path.join(import.meta.dir, '..', 'index.ts');

it('refArgument accepts a ref from browser refs and rejects anything else', () => {
  expect(refArgument('0')).toBe(0);
  expect(refArgument('12')).toBe(12);
  expect(refArgument(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => refArgument('9007199254740992')).toThrow(InvalidArgumentError);
  for (const bad of ['abc', '-1', '1.5', '12abc', '', ' ', '0x10', '1e1', '99999999999999999999']) {
    expect(() => refArgument(bad)).toThrow(InvalidArgumentError);
  }
  expect(() => refArgument('abc')).toThrow('is not a ref');
});

it('intOption parses base 10 even when the previous value would be a radix', () => {
  expect(parseInt('10', 8)).toBe(8);
  expect(intOption('10', 8)).toBe(10);
  const withDefault = new Command().exitOverride();
  withDefault.option('--n <n>', 'n', intOption, 8);
  withDefault.parse(['--n', '10'], { from: 'user' });
  expect(withDefault.opts().n).toBe(10);
  const repeated = new Command().exitOverride();
  repeated.option('--n <n>', 'n', intOption);
  repeated.parse(['--n', '8', '--n', '10'], { from: 'user' });
  expect(repeated.opts().n).toBe(10);
  expect(intOption('-3')).toBe(-3);
  expect(intOption(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => intOption('9007199254740992')).toThrow(InvalidArgumentError);
  expect(() => intOption('-9007199254740992')).toThrow(InvalidArgumentError);
  expect(intOption('-9007199254740991')).toBe(-9007199254740991);
  for (const bad of ['1.5', '', '0x10', '1e3', '99999999999999999999']) expect(() => intOption(bad)).toThrow(InvalidArgumentError);
  expect(() => intOption('nope')).toThrow('is not an integer');
});

it('pointArgument reads an X,Y viewport point', () => {
  expect(pointArgument('320,540')).toEqual({ x: 320, y: 540 });
  expect(pointArgument(' 320, 540 ')).toEqual({ x: 320, y: 540 });
  expect(pointArgument('-1.5,2')).toEqual({ x: -1.5, y: 2 });
  expect(() => pointArgument('320')).toThrow(InvalidArgumentError);
  expect(() => pointArgument('a,b')).toThrow('is not X,Y');
});

it('hover abc fails before any IPC', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'browser-args-'));
  mkdirSync(path.join(root, 'browser', 'run'), { recursive: true });
  const requests: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      requests.push(buffer);
      socket.write(JSON.stringify({ ok: false, error: 'stub', version: version() }) + '\n');
      socket.end();
    });
  });
  const endpoint = ipcEndpoint(path.join(root, 'browser', 'run', 'browser.sock'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  const run = (args: string[]) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, HOME: root, AGENTS_HOME: root, AGENTS_BROWSER_TASK: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 8_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
  try {
    const bad = await run(['hover', 'abc']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(`command-argument value 'abc' is invalid for argument 'ref'`);
    expect(bad.stderr).toContain('"abc" is not a ref');
    expect(requests).toEqual([]);
    const good = await run(['hover', '4']);
    expect(requests.some((line) => line.includes('"action":"hover"') && line.includes('"ref":4'))).toBe(true);
    expect(good.code).toBe(1);
    expect(good.stderr).toContain('stub');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
