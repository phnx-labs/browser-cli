#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const name = '@phnx-labs/browser-cli-' + process.platform + '-' + process.arch;
let executable;
try {
  executable = require.resolve(name + '/' + (process.platform === 'win32' ? 'browser.exe' : 'browser'));
} catch {
  console.error('browser: missing ' + name + '. Reinstall @phnx-labs/browser-cli with optional dependencies enabled.');
  process.exit(1);
}
const stdio = ['inherit', 'inherit', 'inherit'];
for (const key of ['BROWSER_CONTEXT_FD', 'BROWSER_EVENTS_FD']) {
  if (process.env[key] === undefined) continue;
  const fd = Number(process.env[key]);
  if (!Number.isInteger(fd) || fd < 3 || fd > 16) {
    console.error('browser: invalid ' + key);
    process.exit(1);
  }
  while (stdio.length <= fd) stdio.push('ignore');
  stdio[fd] = fd;
}
// The browser skill ships beside this launcher (skills/browser/); the binary reads
// it from here so `browser skills` always matches the installed version.
// Always this package's copy: an inherited value would serve another version's skill.
const env = { ...process.env, BROWSER_SKILLS_DIR: path.join(__dirname, '..', 'skills') };
const child = spawn(executable, process.argv.slice(2), { stdio, env, windowsHide: true });
child.on('error', error => { console.error('browser: ' + error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal && process.platform !== 'win32') {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code === null ? 1 : code;
  }
});
