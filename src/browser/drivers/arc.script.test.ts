import { describe, expect, test } from 'bun:test';
import { createArcTabScript, selectArcTabScript, selectForCaptureScript } from './arc.js';

// Arc reorders `every window` when a tab is made in a window not in front, so an
// id read through `window <index>` after `make new tab` can name another window.
// Source-text assertions: the failure needs a live Arc with two windows, and a
// `node:child_process` mock leaked into later test files in CI.
describe('createArcTab script', () => {
  test('records the window and Space from captured ids, and re-finds the window after making the tab', () => {
    const script = createArcTabScript({ windowId: 'W-1', spaceId: 'S-1' }, 'https://agents-browser.invalid/m');
    const afterMake = script.slice(script.indexOf('make new tab'));
    expect(script).toContain('make new tab');
    expect(afterMake).not.toContain('id of window targetWindowIndex');
    expect(afterMake).toContain('item targetWindowIndex of windowIds');
    expect(afterMake).toContain('item targetSpaceIndex of spaceIds');
    const relookup = afterMake.indexOf('set windowIds to id of every window');
    expect(relookup).toBeGreaterThan(-1);
    expect(relookup).toBeLessThan(afterMake.indexOf('set createdUrls'));
  });
});

describe('selectArcTab script', () => {
  const ref = { windowId: 'W-1', spaceId: 'S-1', tabId: 'T-1' };
  test('activate brings Arc to the front after selecting, and never sets a window index (Arc refuses it)', () => {
    const script = selectArcTabScript(ref, { activate: true });
    const select = script.indexOf('select targetTab');
    expect(select).toBeGreaterThan(-1);
    expect(script.indexOf('\nactivate', select)).toBeGreaterThan(select);
    expect(script).not.toContain('set index of window');
  });
  test('without activate it only selects', () => {
    const script = selectArcTabScript(ref);
    expect(script).toContain('select targetTab');
    expect(script).not.toContain('set index of window');
    expect(script).not.toContain('\nactivate');
  });
});

describe('selectForCaptureScript', () => {
  const script = selectForCaptureScript({ windowId: 'W-agent', spaceId: 'S-1', tabId: 'T-1' });
  test('never raises a window or brings Arc to the front', () => {
    expect(script).not.toContain('set index of window');
    expect(script).not.toContain('\nactivate');
  });
  test('refuses before selecting when another window shows the tab', () => {
    const refuse = script.indexOf('Another Arc window is showing this tab');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(script.indexOf('select targetTab'));
  });
  test('selects only a tab the window is not already showing', () => {
    expect(script).toContain("is not (\"T-1\") then select targetTab");
  });
  test('reads geometry only once the tab is the window\'s selected tab', () => {
    const select = script.indexOf('select targetTab');
    const confirm = script.lastIndexOf('if (id of active tab of window targetWindowIndex as text) is not');
    expect(confirm).toBeGreaterThan(select);
    expect(script.indexOf('innerWidth')).toBeGreaterThan(confirm);
  });
});
