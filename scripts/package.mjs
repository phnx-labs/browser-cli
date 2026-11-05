import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const target = process.argv[2];
if (!/^(darwin-(arm64|x64)|linux-(arm64|x64)|win32-x64)$/.test(target)) throw new Error('Invalid platform target');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [os, cpu] = target.split('-');
const binary = os === 'win32' ? 'browser.exe' : 'browser';
writeFileSync('dist/' + target + '/package.json', JSON.stringify({
  name: pkg.name + '-' + target, version: pkg.version, description: pkg.description,
  os: [os], cpu: [cpu], files: [binary, 'LICENSE'],
  license: pkg.license, repository: pkg.repository
}, null, 2) + '\n');
copyFileSync('LICENSE', 'dist/' + target + '/LICENSE');
