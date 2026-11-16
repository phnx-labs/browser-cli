import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNotifier, isVisible, notificationCommand, pageLabel, seeShown } from './visibility.js';

const arc = { name: 'Arc', bundleId: 'company.thebrowser.Browser' };
const codium = { name: 'VSCodium', bundleId: 'com.vscodium' };

describe('isVisible', () => {
  test('only the selected tab of the front window, in the app in front, is visible', () => {
    expect(isVisible(arc, true, arc)).toBe(true);
    expect(isVisible(arc, true, codium)).toBe(false);
    expect(isVisible(arc, false, arc)).toBe(false);
    expect(isVisible(arc, true, undefined)).toBe(false);
    expect(isVisible(undefined, true, arc)).toBe(false);
  });
});

describe('notificationCommand', () => {
  test('terminal-notifier: clicking brings the viewer up, and a re-show replaces the last one', () => {
    expect(notificationCommand(arc, 'Q3 report', '/opt/homebrew/bin/terminal-notifier')).toEqual({
      kind: 'clickable',
      argv: ['/opt/homebrew/bin/terminal-notifier', '-title', 'browser show', '-message', 'Page ready in Arc: Q3 report',
        '-activate', 'company.thebrowser.Browser', '-group', 'browser-show'],
    });
  });

  test('without it, osascript can only tell; the title is quoted for AppleScript and never activates', () => {
    const { kind, argv } = notificationCommand(arc, 'say "hi" \\ bye\nnext', undefined);
    expect(kind).toBe('plain');
    expect(argv).toEqual(['/usr/bin/osascript', '-e', 'display notification "Page ready in Arc: say \\"hi\\" \\\\ bye next" with title "browser show"']);
    expect(argv.join(' ')).not.toContain('activate');
  });
});

test('findNotifier takes an executable terminal-notifier from PATH, and skips a file that is not executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-notifier-'));
  try {
    writeFileSync(join(dir, 'terminal-notifier'), '#!/bin/sh\n', { mode: 0o644 });
    const real = join(import.meta.dir, 'testdata/notifier');
    expect(findNotifier(`${dir}:${real}`)).toBe(join(real, 'terminal-notifier'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pageLabel prefers the title, else the file name or host and path', () => {
  expect(pageLabel('Board', 'https://example.com/b')).toBe('Board');
  expect(pageLabel('', 'file:///tmp/a%20b/board.html')).toBe('board.html');
  expect(pageLabel('https://example.com/r/', 'https://example.com/r/')).toBe('example.com/r');
  expect(pageLabel('', '/tmp/shot.png')).toBe('shot.png');
});

test.skipIf(process.platform === 'darwin')('off macOS nothing claims the page is visible, and no notification is posted', async () => {
  expect(await seeShown(arc, true, 'Board')).toEqual({
    visible: false, frontmost: 'unknown', notification: 'none',
    unknownWhy: `only macOS reports the app in front, and this is ${process.platform}`,
  });
});
