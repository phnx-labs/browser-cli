import { expect, it } from 'bun:test';
import { buildProgram } from '../index.js';

// The CLI sends `wait` as parsed and the IPC handler settles unless it is false,
// so the three spellings must parse to undefined, true and false.
it('actions settle unless --no-wait; --wait from an older skill still parses', () => {
  for (const verb of ['navigate', 'click', 'type', 'select', 'press']) {
    const parsed = (args: string[]) => {
      const cmd = buildProgram().commands.find((c) => c.name() === verb)!;
      cmd.parseOptions(args);
      return cmd.opts().wait;
    };
    expect(parsed([])).toBeUndefined();
    expect(parsed(['--wait'])).toBe(true);
    expect(parsed(['--no-wait'])).toBe(false);
  }
});
