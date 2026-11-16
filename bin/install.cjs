'use strict';
// postinstall: put the platform binary where the `browser` bin points, so each
// command skips starting Node first (about 30 ms a call). Anything unexpected,
// Windows (npm's .cmd shim runs node), pnpm/yarn shims and a source checkout all
// keep bin/browser.cjs, the slower JavaScript launcher that works the same.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const agent = process.env.npm_config_user_agent || '';
const installed = __dirname.split(path.sep).includes('node_modules');
const launcher = path.join(__dirname, 'browser.cjs');
if (installed && process.platform !== 'win32' && /^(npm|bun)\//.test(agent)) {
  const staged = path.join(__dirname, '.browser-native');
  try {
    const { version } = require('../package.json');
    const binary = require.resolve('@phnx-labs/browser-cli-' + process.platform + '-' + process.arch + '/browser');
    fs.rmSync(staged, { force: true });
    try {
      fs.linkSync(binary, staged);
    } catch {
      fs.copyFileSync(binary, staged);
    }
    fs.chmodSync(staged, 0o755);
    const probe = spawnSync(staged, ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (probe.status !== 0 || probe.stdout.trim() !== version) throw new Error('version probe failed');
    fs.renameSync(staged, launcher);
  } catch {
    // Keep the launcher.
  }
  // rename() leaves both names when they are already one file (a reinstall).
  fs.rmSync(staged, { force: true });
}

const runByRoot = process.getuid && process.getuid() === 0;
const global = process.env.npm_config_global === 'true' || __dirname.split(path.sep).join('/').includes('/.bun/install/global/');
const quiet = ['BROWSER_NO_UPDATE_NOTIFIER', 'CI', 'CODESPACES', 'BUILD_NUMBER', 'RUN_ID'].some((key) => process.env[key]);
if (installed && global && !runByRoot && !quiet) {
  try {
    const head = Buffer.alloc(2);
    const fd = fs.openSync(launcher, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    const viaNode = head.toString() === '#!';
    const doctor = spawnSync(viaNode ? process.execPath : launcher, [...(viaNode ? [launcher] : []), 'doctor', '--local'], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, BROWSER_NO_UPDATE_NOTIFIER: '1' },
    });
    if (doctor.status === 1 && doctor.stdout) {
      let terminalOrStderr = 2;
      try {
        terminalOrStderr = fs.openSync('/dev/tty', 'w');
      } catch {}
      fs.writeSync(terminalOrStderr, '\n@phnx-labs/browser-cli: `browser doctor --local` found a problem with this install:\n' + doctor.stdout + '\n');
    }
  } catch {}
}
