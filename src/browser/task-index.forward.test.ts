import { describe, expect, test } from 'bun:test';
import { startForwardTarget } from './task-index.js';

describe('startForwardTarget', () => {
  const base = { hub: 'laptop', self: 'box-b' };

  test('a profile declared on this box runs here (the s1-desktop case)', () => {
    expect(startForwardTarget({ ...base, profile: 's1-desktop', declaring: ['box-b'] })).toBeUndefined();
  });

  test('a profile declared here and elsewhere still runs here', () => {
    expect(startForwardTarget({ ...base, profile: 'shared', declaring: ['laptop', 'box-b'] })).toBeUndefined();
  });

  test('a profile declared only elsewhere goes to the hub', () => {
    expect(startForwardTarget({ ...base, profile: 'arc-work', declaring: ['laptop'] })).toBe('laptop');
  });

  test('a profile no box declares goes to the hub, which reports it', () => {
    expect(startForwardTarget({ ...base, profile: 'typo', declaring: [] })).toBe('laptop');
  });

  test('a bare start and --profile default go to the hub', () => {
    expect(startForwardTarget({ ...base, declaring: [] })).toBe('laptop');
    expect(startForwardTarget({ ...base, profile: 'default', declaring: ['box-b'] })).toBe('laptop');
  });

  test('no hub means no forward', () => {
    expect(startForwardTarget({ self: 'box-b', profile: 's1-desktop', declaring: ['box-b'] })).toBeUndefined();
  });
});
