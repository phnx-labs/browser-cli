import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArcTabScript, selectArcTabScript, selectForCaptureScript } from '../browser/drivers/arc.js';
import { readScript, selectChromiumTabScript } from '../browser/drivers/chromium-mac.js';
import {
  findNotifier, FRONTMOST_JXA, handlerScript, judgeShown, launchedScript, notificationCommand, OS_HANDLER_BLIND, osHandlerTab, pageLabel, seeShown,
} from './visibility.js';

const arc = { name: 'Arc', bundleId: 'company.thebrowser.Browser' };
const codium = { name: 'VSCodium', bundleId: 'com.vscodium' };

describe('judgeShown', () => {
  test('only the selected tab of the front window, in the app in front, is visible', () => {
    expect(judgeShown(arc, { inFront: true }, arc).visible).toBe(true);
    expect(judgeShown(arc, { inFront: true }, codium).visible).toBe(false);
    expect(judgeShown(arc, { inFront: false }, arc).visible).toBe(false);
    expect(judgeShown(arc, { inFront: true }, undefined).visible).toBe(false);
    expect(judgeShown(undefined, { inFront: true }, arc).visible).toBe(false);
  });

  test('an app in front that has not settled is unknown, never visible', () => {
    expect(judgeShown(arc, { inFront: true }, undefined, 'Arc had not finished launching after 5 s')).toEqual({
      visible: false, frontmost: 'unknown', unknownWhy: 'Arc had not finished launching after 5 s',
    });
  });
});

describe('osShow verdict', () => {
  const safari = { name: 'Safari', bundleId: 'com.apple.Safari' };
  test('the OS handler in front is not the page in front: nobody read its tab', () => {
    expect(judgeShown(safari, osHandlerTab(safari), safari)).toEqual({ visible: false, frontmost: 'Safari', unknownWhy: OS_HANDLER_BLIND });
  });
  test('with no handler app named, it says so', () => {
    expect(judgeShown(undefined, osHandlerTab(undefined), safari)).toEqual({
      visible: false, frontmost: 'Safari', unknownWhy: 'macOS named no app that opens it',
    });
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
  expect(await seeShown(arc, { inFront: true }, 'Board')).toEqual({
    visible: false, frontmost: 'unknown', notification: 'none',
    unknownWhy: `only macOS reports the app in front, and this is ${process.platform}`,
  });
});

const RAISES = /\bactivate\b|\bset\s+frontmost\b|\bfrontmost\s*=(?!=)|\breopen\b/i;

describe('no script show runs can raise an app', () => {
  test('the pattern catches every spelling', () => {
    for (const raising of ['activate', 'tell app "Arc" to activate', 'app.activate()', 'Application("Arc").activate', 'set frontmost of p to true', 'proc.frontmost = true', 'reopen']) {
      expect(raising).toMatch(RAISES);
    }
    expect('activeTabIndex; whose({ frontmost: true }); p.frontmost === true').not.toMatch(RAISES);
  });

  const ref = { windowId: 'W-1', spaceId: 'S-1', tabId: 'T-1' };
  const scripts: Record<string, string> = {
    selectArcTab: selectArcTabScript(ref),
    createArcTab: createArcTabScript(ref, 'https://agents-browser.invalid/m'),
    selectForCapture: selectForCaptureScript(ref),
    chromiumRead: readScript(4242),
    chromiumSelect: selectChromiumTabScript('com.google.Chrome', '22', 1),
    frontmost: FRONTMOST_JXA,
    handler: handlerScript('https://example.com/'),
    launched: launchedScript('com.apple.Safari'),
    plainNotification: notificationCommand(arc, 'Board', undefined).argv.join(' '),
  };
  for (const [name, script] of Object.entries(scripts)) {
    test(name, () => expect(script).not.toMatch(RAISES));
  }
});
