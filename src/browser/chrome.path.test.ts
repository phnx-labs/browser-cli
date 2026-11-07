import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findBrowserPath, findOnPath } from './chrome.js';

describe('findOnPath', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-path-'));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds an executable by name, and skips a file that is not executable', () => {
    const plain = path.join(dir, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'firefox'), '');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'firefox'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = [plain, bin].join(path.delimiter);
    expect(findOnPath(['firefox'])).toBe(path.join(bin, 'firefox'));
    expect(findOnPath(['nothing-here'])).toBeUndefined();
  });

  it('never resolves through a relative PATH entry, so the cwd cannot plant a browser', () => {
    const cwd = process.cwd();
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'firefox'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'bin', 'firefox'), '#!/bin/sh\n', { mode: 0o755 });
    process.chdir(dir);
    try {
      process.env.PATH = ['.', 'bin'].join(path.delimiter);
      expect(findOnPath(['firefox'])).toBeUndefined();
    } finally {
      process.chdir(cwd);
    }
  });

  it.skipIf(process.platform !== 'linux' || fs.existsSync('/usr/bin/microsoft-edge'))(
    'lets findBrowserPath use a browser installed without root',
    () => {
      fs.writeFileSync(path.join(dir, 'microsoft-edge'), '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = dir;
      expect(findBrowserPath('edge')).toBe(path.join(dir, 'microsoft-edge'));
    },
  );
});
