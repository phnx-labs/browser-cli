import { describe, expect, test } from 'bun:test';
import { headlessKeyringArgs } from './chrome.js';

describe('headlessKeyringArgs', () => {
  const base = { headless: true, platform: 'linux' as NodeJS.Platform, isElectron: false, ownerStore: false };

  test('a headless managed browser on Linux uses the basic password store', () => {
    expect(headlessKeyringArgs(base)).toEqual(['--password-store=basic']);
  });

  test('a headed browser keeps the keyring', () => {
    expect(headlessKeyringArgs({ ...base, headless: false })).toEqual([]);
  });

  test('macOS and Windows are unchanged', () => {
    expect(headlessKeyringArgs({ ...base, platform: 'darwin' })).toEqual([]);
    expect(headlessKeyringArgs({ ...base, platform: 'win32' })).toEqual([]);
  });

  test("the owner's own store and Electron apps are unchanged", () => {
    expect(headlessKeyringArgs({ ...base, ownerStore: true })).toEqual([]);
    expect(headlessKeyringArgs({ ...base, isElectron: true })).toEqual([]);
  });
});
