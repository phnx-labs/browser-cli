import { expect, test } from 'bun:test';
import * as path from 'path';
import { getUploadStagingDir, uploadTaskDir } from './upload.js';

test('a task upload folder is always one level inside the staging folder, whatever the task name', () => {
  const staging = getUploadStagingDir();
  const names = ['..', '.', '', 'a/b', '../x', '..\\x', 'multi-claude', 'ünïcode', '%2e%2e'];
  const dirs = names.map(uploadTaskDir);
  for (const dir of dirs) expect(path.dirname(dir)).toBe(staging);
  expect(new Set(dirs).size).toBe(names.length);
});
