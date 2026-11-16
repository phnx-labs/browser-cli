import { describe, expect, test } from 'bun:test';
import { chromiumSelection, pickChromiumTab, selectChromiumTabScript, type ChromiumWindow } from './chromium-mac.js';

const tabs = (...urls: string[]) => urls.map((url) => ({ url, title: url }));
const windows: ChromiumWindow[] = [
  { id: '11', index: 1, minimized: false, activeTabIndex: 1, tabs: tabs('https://mail.example/', 'https://example.com/report') },
  { id: '22', index: 2, minimized: false, activeTabIndex: 2, tabs: tabs('https://example.com/report', 'https://news.example/') },
];
const shows = (tab: { url: string }) => tab.url === 'https://example.com/report';

describe('pickChromiumTab', () => {
  test('the window CDP named first, else the first window holding it', () => {
    expect(pickChromiumTab(windows, shows)).toEqual({ windowId: '11', index: 2 });
    expect(pickChromiumTab(windows, shows, '22')).toEqual({ windowId: '22', index: 1 });
    expect(pickChromiumTab(windows, () => false)).toBeUndefined();
  });
  test('two tabs on one page: the marked viewer tab, never the task tab that comes first', () => {
    const marker = 'browser show 6f1c';
    const twin = [{ ...windows[0]!, tabs: [
      { url: 'https://example.com/report', title: 'Report' },
      { url: 'https://mail.example/', title: 'Mail' },
      { url: 'https://example.com/report', title: marker },
    ] }];
    expect(pickChromiumTab(twin, (tab) => tab.title === marker)).toEqual({ windowId: '11', index: 3 });
  });
});

describe('chromiumSelection', () => {
  test('the front window is AppleScript window 1, wherever it sits in the list', () => {
    expect(chromiumSelection(windows, { windowId: '22', index: 2 })).toEqual({ selected: true, frontWindow: false });
    expect(chromiumSelection(windows, { windowId: '11', index: 2 })).toEqual({ selected: false, frontWindow: true });
    const reordered = [{ ...windows[1]!, index: 1 }, { ...windows[0]!, index: 2 }].reverse();
    expect(chromiumSelection(reordered, { windowId: '22', index: 2 })).toEqual({ selected: true, frontWindow: true });
  });
  test('a minimized window 1 is not in front, and the next window does not stand in for it', () => {
    const minimized = [{ ...windows[0]!, minimized: true }, windows[1]!];
    expect(chromiumSelection(minimized, { windowId: '22', index: 2 })).toEqual({ selected: true, frontWindow: false });
    expect(chromiumSelection(minimized, { windowId: '11', index: 1 })).toEqual({ selected: true, frontWindow: false });
  });
});

test('the select script sets the tab index', () => {
  expect(selectChromiumTabScript('com.google.Chrome', '22', 1)).toContain('win.activeTabIndex = 1');
  expect(() => selectChromiumTabScript('com.google.Chrome', '22', 0)).toThrow();
});
