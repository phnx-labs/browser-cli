import { describe, expect, it } from 'bun:test';
import { isServiceUnavailable } from './ipc.js';

const withCode = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('isServiceUnavailable', () => {
  it('treats a missing socket, a refused connect and a long-path EINVAL as "start the service"', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'EINVAL']) {
      expect(isServiceUnavailable(withCode(code))).toBe(true);
    }
  });

  it('leaves other socket errors as real failures', () => {
    for (const code of ['EACCES', 'ETIMEDOUT', 'ECONNRESET']) {
      expect(isServiceUnavailable(withCode(code))).toBe(false);
    }
  });
});
