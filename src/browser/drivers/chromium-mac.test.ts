import { describe, expect, test } from 'bun:test';
import { chromiumSelection, pickChromiumTab, selectChromiumTabScript } from './chromium-mac.js';

const windows = [
  { id: '11', minimized: false, activeTabIndex: 1, urls: ['https://mail.example/', 'https://example.com/report'] },
  { id: '22', minimized: false, activeTabIndex: 2, urls: ['https://example.com/report', 'https://news.example/'] },
];
const shows = (url: string) => url === 'https://example.com/report';

describe('pickChromiumTab', () => {
  test('front window first, unless CDP named the window holding the tab', () => {
    expect(pickChromiumTab(windows, shows)).toEqual({ windowId: '11', index: 2 });
    expect(pickChromiumTab(windows, shows, '22')).toEqual({ windowId: '22', index: 1 });
    expect(pickChromiumTab(windows, () => false)).toBeUndefined();
  });
  test('a tab show just opened is the newest one showing the page, not an older duplicate', () => {
    const dup = [{ ...windows[0]!, urls: ['https://example.com/report', 'https://mail.example/', 'https://example.com/report'] }];
    expect(pickChromiumTab(dup, shows, undefined, true)).toEqual({ windowId: '11', index: 3 });
    expect(pickChromiumTab(dup, shows)).toEqual({ windowId: '11', index: 1 });
  });
});

describe('chromiumSelection', () => {
  test('selected in a window behind the front one is not in front', () => {
    expect(chromiumSelection(windows, { windowId: '22', index: 2 })).toEqual({ selected: true, frontWindow: false });
    expect(chromiumSelection(windows, { windowId: '11', index: 2 })).toEqual({ selected: false, frontWindow: true });
  });
  test('a minimized window is never the front one', () => {
    const minimized = [{ ...windows[0]!, minimized: true }, windows[1]!];
    expect(chromiumSelection(minimized, { windowId: '22', index: 2 })).toEqual({ selected: true, frontWindow: true });
  });
});

test('the select script sets the tab index and never activates the app', () => {
  const script = selectChromiumTabScript('com.google.Chrome', '22', 1);
  expect(script).toContain('win.activeTabIndex = 1');
  expect(script).not.toContain('activate()');
  expect(script).not.toContain('frontmost');
  expect(() => selectChromiumTabScript('com.google.Chrome', '22', 0)).toThrow();
});
