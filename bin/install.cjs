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
if (installed && process.platform !== 'win32' && /^(npm|bun)\//.test(agent)) {
  const launcher = path.join(__dirname, 'browser.cjs');
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
