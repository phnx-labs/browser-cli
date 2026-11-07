import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { arcPageRect, pickArcSpace, pickShowSpace, readArcSidebar, type ArcEnumeratedSpace } from './arc.js';

// Every Arc window lists every Space; rows arrive front to back. This is the
// laptop layout of 2026-10-18 that made `browser start` refuse the Work profile:
// three visible windows, two of them showing Work.
const SPACES = [
  { id: 'gmail', title: 'Gmail' },
  { id: 'work', title: 'Work' },
  { id: 'computers', title: 'Computers' },
];
function windowRows(windowId: string, activeSpaceId: string): ArcEnumeratedSpace[] {
  return SPACES.map((space) => ({
    windowId, spaceId: space.id, spaceTitle: space.title, activeSpaceId, tabs: [],
  }));
}

describe('pickArcSpace', () => {
  const work = [{ id: 'work', title: 'Work' }, { id: 'computers', title: 'Computers' }];

  test('picks the frontmost window showing one of the profile Spaces, among several', () => {
    const live = [...windowRows('w-gmail', 'gmail'), ...windowRows('w-a', 'work'), ...windowRows('w-b', 'work')];
    expect(pickArcSpace(work, live)).toEqual({ windowId: 'w-a', spaceId: 'work', spaceTitle: 'Work' });
  });

  test('takes the Space a window shows, not just the first in sidebar order', () => {
    const live = [...windowRows('w-a', 'computers'), ...windowRows('w-b', 'work')];
    expect(pickArcSpace(work, live)).toEqual({ windowId: 'w-a', spaceId: 'computers', spaceTitle: 'Computers' });
  });

  test('falls back to the frontmost window and the first profile Space', () => {
    const live = [...windowRows('w-front', 'gmail'), ...windowRows('w-back', 'gmail')];
    expect(pickArcSpace(work, live)).toEqual({ windowId: 'w-front', spaceId: 'work', spaceTitle: 'Work' });
  });

  test('works when Arc did not report an active Space', () => {
    const live = windowRows('w-only', '').map((row) => ({ ...row, activeSpaceId: undefined }));
    expect(pickArcSpace(work, live)).toEqual({ windowId: 'w-only', spaceId: 'work', spaceTitle: 'Work' });
  });

  test('returns undefined with no visible window', () => {
    expect(pickArcSpace(work, [])).toBeUndefined();
  });
});

// When the recorded agent window was the owner's only visible Arc window, every
// `browser show` failed with "via": "none".
describe('pickShowSpace', () => {
  const work = [{ id: 'work', title: 'Work' }, { id: 'computers', title: 'Computers' }];

  test('prefers a window that is not an agent window', () => {
    const live = [...windowRows('w-agent', 'work'), ...windowRows('w-owner', 'gmail')];
    expect(pickShowSpace(work, live, new Set(['w-agent']))).toEqual({ windowId: 'w-owner', spaceId: 'work', spaceTitle: 'Work' });
  });

  test('uses the agent window when it is the only visible one', () => {
    expect(pickShowSpace(work, windowRows('w-agent', 'work'), new Set(['w-agent', 'w-retired'])))
      .toEqual({ windowId: 'w-agent', spaceId: 'work', spaceTitle: 'Work' });
  });

  test('without a recorded agent window it is pickArcSpace', () => {
    const live = windowRows('w-only', 'gmail');
    expect(pickShowSpace(work, live, new Set())).toEqual(pickArcSpace(work, live));
  });

  test('returns undefined with no visible window', () => {
    expect(pickShowSpace(work, [], new Set(['w-agent']))).toBeUndefined();
  });
});

describe('arcPageRect', () => {
  const arcWindow = {
    imageWidth: 2304, imageHeight: 1204, windowWidth: 2304, windowHeight: 1204,
    innerWidth: 2048, innerHeight: 1152, devicePixelRatio: 2, backingScale: 2, sidebarWidth: 246,
  };

  test('keeps the page and drops the sidebar and toolbar', () => {
    expect(arcPageRect(arcWindow)).toEqual({ x: 246, y: 42, width: 2048, height: 1152 });
  });

  test('scales with a capture taken at 2 pixels per point', () => {
    expect(arcPageRect({ ...arcWindow, imageWidth: 4608, imageHeight: 2408 })).toEqual({ x: 492, y: 84, width: 4096, height: 2304 });
  });

  test('a zoomed-out page reports more CSS pixels but covers the same points', () => {
    expect(arcPageRect({ ...arcWindow, innerWidth: 2560, innerHeight: 1440, devicePixelRatio: 1.6 })).toEqual({ x: 246, y: 42, width: 2048, height: 1152 });
  });

  test('refuses a page reported wider than the space right of the sidebar', () => {
    expect(() => arcPageRect({ ...arcWindow, innerWidth: 2100 })).toThrow('overlap Arc\'s sidebar');
    expect(() => arcPageRect({ ...arcWindow, innerWidth: 2400 })).toThrow('overlap Arc\'s sidebar');
  });

  test('refuses when Arc records a wider sidebar than the page leaves room for', () => {
    expect(() => arcPageRect({ ...arcWindow, sidebarWidth: 300 })).toThrow('overlap Arc\'s sidebar');
  });

  test('refuses a capture whose shape is not the window\'s, such as one with its shadow', () => {
    expect(() => arcPageRect({ ...arcWindow, imageHeight: 1300 })).toThrow('not the shape');
  });

  test('refuses missing geometry', () => {
    expect(() => arcPageRect({ ...arcWindow, backingScale: 0 })).toThrow('geometry');
  });
});

describe('readArcSidebar', () => {
  const file = (name: string) => join(import.meta.dir, '..', 'testdata', 'arc', 'windows', name);
  test('reads the window\'s own record', () => {
    expect(readArcSidebar('W-agent', file('anchored.json'))).toEqual({ width: 246 });
  });
  test('a window Arc has not written yet takes the app preference', () => {
    expect(readArcSidebar('W-new', file('anchored.json'))).toEqual({ width: 228 });
  });
  test('refuses a sidebar that is not anchored', () => {
    expect(() => readArcSidebar('W-hidden', file('anchored.json'))).toThrow('anchored');
  });
  test('refuses an unreadable layout', () => {
    expect(() => readArcSidebar('W-agent', file('missing.json'))).toThrow('StorableWindows.json');
  });
});
