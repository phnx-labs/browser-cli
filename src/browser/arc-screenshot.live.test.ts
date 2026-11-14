import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Needs Arc and `computer setup`; AGENTS_TEST_ARC_PROFILE is the Arc profile directory, e.g. "Profile 1".
const arcProfile = process.env.AGENTS_TEST_ARC_PROFILE;
const entry = join(import.meta.dir, '..', 'index.ts');

function osa(source: string): string {
  const run = Bun.spawnSync(['/usr/bin/osascript', '-e', source]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

const frontmost = () => osa('tell application "System Events" to name of first process whose frontmost is true');
// Ids only: the owner's URLs and titles are never read.
const selectedTabs = () => osa(`tell application id "company.thebrowser.Browser"
  set out to {}
  repeat with wi from 1 to count of windows
    try
      set end of out to (id of window wi) & "=" & (id of active tab of window wi)
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return out as text
end tell`).split('\n');

test.skipIf(process.platform !== 'darwin' || !arcProfile)('Arc waits on the page, and a screenshot captures the agent window and leaves the owner where they were', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-arc-shot-'));
  const bin = join(home, 'bin');
  mkdirSync(join(home, 'browser', 'profiles'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, 'browser', 'profiles', 'test.yaml'), [
    'arc-test:', '  browser: arc', '  endpoints:', '    native:', '      target: arc-native://local',
    '  defaultEndpoint: native', '  launchPolicy: attach-only', '  arc:', `    profileId: ${JSON.stringify(arcProfile)}`, '    profileName: Test', '',
  ].join('\n'));
  const real = Bun.which('computer');
  writeFileSync(join(bin, 'computer'), `#!/bin/sh\nAGENTS_HOME="$HOME/.agents" exec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, 'computer'), 0o755);
  const env = { ...process.env, AGENTS_HOME: home, AGENTS_SYNC_MACHINE_ID: 'test', PATH: `${bin}:${process.env.PATH}` };
  const cli = (...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, entry, ...args], { env, stderr: 'pipe' });
    if (run.exitCode !== 0) throw new Error(`browser ${args.join(' ')}: ${run.stderr.toString()}`);
    return run.stdout.toString();
  };
  const app = frontmost();
  let task: string | undefined;
  try {
    const owner = selectedTabs();
    task = JSON.parse(cli('start', '--profile', 'arc-test', '--url', 'https://example.com/', '--json')).task;
    for (const condition of [['--time', '200'], ['--selector', 'p'], ['--url', 'example.com'], ['--state', 'load'], ['--fn', 'document.title.length > 0']]) {
      cli('wait', '--task', task!, ...condition, '--timeout', '10000');
    }
    cli('evaluate', '--task', task!, "void setTimeout(() => { document.body.dataset.late = 'yes'; }, 1000)");
    cli('wait', '--task', task!, '--fn', "document.querySelector('[data-late]').dataset.late === 'yes'", '--timeout', '10000');
    const started = Date.now();
    const missing = Bun.spawnSync([process.execPath, entry, 'wait', '--task', task!, '--selector', '#absent', '--timeout', '1000'], { env, stderr: 'pipe' });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain('not met within 1000ms');
    expect(Date.now() - started).toBeLessThan(5000);
    for (const [name, quality] of [['shot.jpg', 'compressed'], ['again.jpg', 'compressed'], ['raw.png', 'raw']]) {
      const shot = join(home, name);
      cli('screenshot', '--task', task!, '-q', quality, '-o', shot);
      const size = Bun.spawnSync(['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', shot]).stdout.toString();
      expect(size).toMatch(/pixelWidth: [1-9]/);
      expect(`${name}: ${frontmost()}`).toBe(`${name}: ${app}`);
    }
    const after = selectedTabs();
    for (const window of owner) expect(after).toContain(window);
  } finally {
    if (task) cli('stop', '--task', task);
    cli('stop', '--service');
    const agent = join(home, 'browser', 'run', 'arc-agent-window.json');
    if (existsSync(agent)) {
      osa(`tell application id "company.thebrowser.Browser"
  set ids to id of every window
  repeat with wi from 1 to count of ids
    if (item wi of ids as text) is ${JSON.stringify(JSON.parse(readFileSync(agent, 'utf8')).windowId)} then close window wi
  end repeat
end tell`);
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
