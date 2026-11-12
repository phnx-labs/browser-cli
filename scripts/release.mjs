import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, realpathSync, rmSync, chmodSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isPublishedFileAllowed } from './published-files.mjs';

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--confirm') throw new Error('Unknown option: ' + arg);
}
const ci = Boolean(process.env.GITHUB_ACTIONS);
const started = Date.now();
const elapsed = () => ((Date.now() - started) / 1000).toFixed(1) + 's';
// In the workflow, main's test.yml run for this commit already checked the docs.
if (!ci) run('bash', ['scripts/generate-cli-docs.sh', '--check'], { stdio: 'inherit', timeout: 0 });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const [name, version] of Object.entries(pkg.optionalDependencies)) {
  if (version !== pkg.version) throw new Error('Platform dependency version mismatch: ' + name);
}
const targets = Object.keys(pkg.optionalDependencies).map(name => name.slice(pkg.name.length + 1));
// Every command fails after two minutes unless it says otherwise, so a hang ends the run.
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(command + ' ' + argv.join(' ') + '\n' + (result.stderr || result.error || result.stdout));
  return result.stdout?.trim() ?? '';
}
function runAsync(command, argv, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { timeout: 120_000, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (status === 0) resolveRun(stdout.trim());
      else reject(new Error(command + ' ' + argv.join(' ') + (signal ? ' (' + signal + ')' : '') + '\n' + (stderr || stdout)));
    });
  });
}
async function registry(name) {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(await runAsync('npm', ['view', name + '@' + pkg.version, 'dist.integrity', '--json', '--prefer-online']));
    } catch (error) {
      if (/E404/.test(error.message)) return null;
      if (attempt === 4) throw new Error('Cannot query registry for ' + name + ': ' + error.message);
      console.log('Registry query for ' + name + ' failed, retrying: ' + error.message.split('\n').find(line => /npm error|ERR/.test(line)));
      await delay(3000 * attempt);
    }
  }
}
// npm has taken 19 minutes to show a 43 MB package (win32-x64 0.1.30; the 35-minute job outlasts it),
// and a tarball can 404 after its version shows (0.2.0's launcher), so an install waits for both.
async function waitForRegistry(name) {
  const deadline = Date.now() + 25 * 60_000;
  const tarball = 'https://registry.npmjs.org/' + name + '/-/' + name.split('/').pop() + '-' + pkg.version + '.tgz';
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const integrity = await registry(name);
    if (integrity && (await fetch(tarball, { method: 'HEAD', signal: AbortSignal.timeout(30_000) }).catch(() => null))?.ok) return integrity;
    if (attempt === 0) console.log('Waiting for npm to process ' + name);
    await delay(2000);
  }
  throw new Error('Published package is still not visible after 25 minutes: ' + name + '. npm may still be processing it; rerun `bash scripts/release.sh --confirm` once `npm view ' + name + '@' + pkg.version + '` answers.');
}
if (!/^\d+\.\d+\.\d+(-pre\.(0|[1-9]\d*))?$/.test(pkg.version)) throw new Error('Version must be x.y.z or x.y.z-pre.n');
const branch = 'release/' + pkg.version;
const distTag = pkg.version.includes('-pre.') ? 'pre' : 'latest';
// The GitHub release carries this version's CHANGELOG section, checked before anything publishes.
const notes = readFileSync('CHANGELOG.md', 'utf8').split(/^## /m).find(section => section.split('\n')[0].trim() === pkg.version)?.split('\n').slice(1).join('\n').trim();
if (!notes) throw new Error('CHANGELOG.md has no "## ' + pkg.version + '" section with notes; the GitHub release takes its notes from it');
if (distTag === 'latest') {
  const latest = run('npm', ['view', pkg.name, 'dist-tags.latest']);
  const [a, b] = [pkg.version, latest].map(version => version.split('.').map(Number));
  if ((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0) throw new Error(pkg.version + ' is older than latest ' + latest + '; it would move latest backwards');
}
const scratch = resolve('.agents/scratch/release');
const tested = resolve(scratch, 'compiled-packages');
const packages = targets.map(target => ({ name: pkg.name + '-' + target, dir: resolve(tested, target) }));
packages.push({ name: pkg.name, dir: resolve('.') });
const launcher = packages.at(-1);
const published = new Map(await Promise.all(packages.map(async item => [item.name, await registry(item.name)])));
const sha = run('git', ['rev-parse', 'HEAD']);
const tag = 'v' + pkg.version;
const remoteTag = run('git', ['ls-remote', '--tags', 'origin', 'refs/tags/' + tag, 'refs/tags/' + tag + '^{}']);
if (remoteTag && !remoteTag.split('\n').some(line => line.startsWith(sha + '\t'))) {
  throw new Error('Published tag does not point to this release commit');
}
const localTag = spawnSync('git', ['rev-parse', tag + '^{}'], { encoding: 'utf8' });
if (localTag.status === 0 && localTag.stdout.trim() !== sha) throw new Error('Existing local tag points to another commit');
console.log('Release ' + pkg.name + '@' + pkg.version + ' (dist-tag ' + distTag + ') from ' + sha + ' on ' + branch);
for (const item of packages) console.log((published.get(item.name) ? 'Verify existing: ' : 'Publish: ') + item.name);
function workflowRun(workflow, ref) {
  const runs = JSON.parse(run('gh', ['run', 'list', '--workflow', workflow, '--branch', ref, '--event', 'push', '--commit', sha, '--limit', '1', '--json', 'databaseId,url,status,conclusion']));
  return runs[0];
}
if (!ci && !args.has('--confirm')) {
  console.log('Dry run. --confirm waits for main CI on this commit, pushes ' + branch + ' (whose workflow publishes the packages that CI built and tested), then verifies the installed CLI.');
  process.exit(0);
}
if (args.has('--confirm') && run('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Release requires a clean checkout');
if (!ci) {
  run('git', ['fetch', 'origin', 'main']);
  const remoteBranch = run('git', ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch]).split('\t')[0];
  const gitDir = run('git', ['rev-parse', '--git-dir']);
  const commonDir = run('git', ['rev-parse', '--git-common-dir']);
  if (resolve(gitDir) === resolve(commonDir)) throw new Error('Release from a linked worktree; primary checkout is protected');
  if (remoteBranch && remoteBranch !== sha) throw new Error(branch + ' already exists at ' + remoteBranch + '; release from that commit');
  if (!remoteBranch && sha !== run('git', ['rev-parse', 'origin/main'])) throw new Error('Release requires the reviewed origin/main commit, or an existing ' + branch);
  const mainCi = workflowRun('test.yml', 'main');
  if (!mainCi) throw new Error('main CI (test.yml) has not run on ' + sha + '; the release publishes only what it built and tested');
  if (mainCi.status !== 'completed') {
    console.log('Waiting for main CI: ' + mainCi.url);
    run('gh', ['run', 'watch', String(mainCi.databaseId), '--exit-status'], { stdio: 'inherit', timeout: 0 });
  } else if (mainCi.conclusion !== 'success') {
    throw new Error('main CI failed on ' + sha + ': ' + mainCi.url);
  }
  if (!remoteBranch) run('git', ['push', 'origin', sha + ':refs/heads/' + branch], { stdio: 'inherit' });
  let releaseRun;
  for (let attempt = 0; attempt < 24 && !releaseRun; attempt++) {
    if (attempt) await delay(5000);
    releaseRun = workflowRun('release.yml', branch);
  }
  if (!releaseRun) throw new Error('The release workflow did not start for ' + branch + ' within 2 minutes');
  console.log('Release workflow: ' + releaseRun.url);
  if (releaseRun.status === 'completed' && releaseRun.conclusion !== 'success') {
    run('gh', ['run', 'rerun', String(releaseRun.databaseId)], { stdio: 'inherit' });
    await delay(5000);
  }
  run('gh', ['run', 'watch', String(releaseRun.databaseId), '--exit-status'], { stdio: 'inherit', timeout: 0 });
  verifyInstall();
  process.exit(0);
}
if (args.has('--confirm')) {
  if (process.env.GITHUB_REF_NAME !== branch) throw new Error('package.json says ' + pkg.version + ', so it releases only from ' + branch + ', not ' + process.env.GITHUB_REF_NAME);
  const remoteBranch = run('git', ['ls-remote', '--heads', 'origin', 'refs/heads/' + branch]).split('\t')[0];
  if (sha !== remoteBranch) throw new Error(branch + ' on origin is at ' + (remoteBranch || 'nothing') + ', not ' + sha + '; only its newest push releases');
  const [major, minor, patch] = run('npm', ['--version']).split('.').map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) throw new Error('Publishing with provenance needs npm 11.5.1 or newer');
}
// In the workflow: publish main CI's compiled-packages for this commit, byte for byte.
const mainCi = workflowRun('test.yml', 'main');
if (mainCi?.conclusion !== 'success') throw new Error('No successful main CI (test.yml) run for ' + sha + (mainCi ? ': ' + mainCi.url : '') + '; release only a commit main CI built and tested');
const [artifact] = JSON.parse(run('gh', ['api', 'repos/{owner}/{repo}/actions/runs/' + mainCi.databaseId + '/artifacts?name=compiled-packages'])).artifacts;
if (!artifact || artifact.expired || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) throw new Error('main CI run ' + mainCi.url + ' has no unexpired compiled-packages artifact with a digest');
if (artifact.workflow_run?.head_sha !== sha || artifact.workflow_run?.head_branch !== 'main') throw new Error('compiled-packages ' + artifact.id + ' was built from ' + artifact.workflow_run?.head_branch + '@' + artifact.workflow_run?.head_sha + ', not main@' + sha);
rmSync(tested, { recursive: true, force: true });
mkdirSync(tested, { recursive: true });
const zip = resolve(scratch, 'compiled-packages.zip');
const zipFd = openSync(zip, 'w');
try {
  run('gh', ['api', 'repos/{owner}/{repo}/actions/artifacts/' + artifact.id + '/zip'], { stdio: ['ignore', zipFd, 'pipe'], encoding: 'buffer' });
} finally {
  closeSync(zipFd);
}
const digest = 'sha256:' + createHash('sha256').update(readFileSync(zip)).digest('hex');
if (digest !== artifact.digest) throw new Error('Downloaded compiled-packages is ' + digest + ', GitHub recorded ' + artifact.digest);
run('unzip', ['-q', zip, '-d', tested]);
console.log('Fetched compiled-packages ' + digest + ' from ' + mainCi.url + ' (' + elapsed() + ')');
const staged = await Promise.all(packages.map(async item => {
  const manifest = JSON.parse(readFileSync(item.dir + '/package.json', 'utf8'));
  if (manifest.name !== item.name || manifest.version !== pkg.version) throw new Error('Stale package: ' + item.dir);
  if (item !== launcher) {
    const binary = item.dir + '/' + (item.name.includes('win32') ? 'browser.exe' : 'browser');
    if (!existsSync(binary)) throw new Error('Missing compiled binary: ' + item.dir);
    // Artifacts drop the mode bit that bun build --compile set.
    if (!item.name.includes('win32')) chmodSync(binary, 0o755);
  }
  const [pack] = JSON.parse(await runAsync('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: item.dir }));
  for (const file of pack.files) {
    if (!isPublishedFileAllowed(file.path, { launcher: item === launcher })) throw new Error('Unexpected published file: ' + item.name + '/' + file.path);
  }
  const integrity = published.get(item.name);
  if (integrity && integrity !== pack.integrity) throw new Error('Published version differs from staged bytes: ' + item.name);
  return { ...item, integrity: pack.integrity, tarball: resolve(scratch, pack.filename) };
}));
console.log('Packed ' + staged.length + ' packages (' + elapsed() + ')');
if (!args.has('--confirm')) {
  console.log('Dry run: staged every package from main CI; nothing published.');
  process.exit(0);
}
// Platform packages at once, then the launcher once npm shows them all, so no install
// resolves a launcher without its binary. All settle before a failure is thrown.
async function publishAndWait(items) {
  const results = await Promise.allSettled(items.map(async item => {
    if (!published.get(item.name)) {
      try {
        await runAsync('npm', ['publish', item.tarball, '--access', 'public', '--provenance', '--tag', distTag]);
        console.log('Published ' + item.name + ' (' + elapsed() + ')');
      } catch (error) {
        // A rerun while npm still processes a version it accepted: the wait below checks its bytes.
        if (!/E403/.test(error.message) || !/cannot publish over/i.test(error.message)) throw error;
        console.log('npm already accepted ' + item.name + '@' + pkg.version + '; waiting for it');
      }
    }
    if (await waitForRegistry(item.name) !== item.integrity) throw new Error('Registry integrity differs from the staged package: ' + item.name);
    console.log('npm shows ' + item.name + '@' + pkg.version + ' (' + elapsed() + ')');
  }));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
  if (failures.length) throw new Error(failures.length + ' of ' + items.length + ' packages failed:\n' + failures.join('\n'));
}
await publishAndWait(staged.filter(item => item.name !== launcher.name));
await publishAndWait(staged.filter(item => item.name === launcher.name));
if (!remoteTag) {
  if (localTag.status !== 0) run('git', ['tag', '-a', tag, '-m', pkg.name + ' ' + pkg.version, sha]);
  run('git', ['push', 'origin', tag], { stdio: 'inherit' });
}
// npm and GitHub show the same newest version: a rerun after this step finds the release and leaves it.
const kind = distTag === 'latest' ? '--latest' : '--prerelease';
const ghRelease = spawnSync('gh', ['release', 'create', tag, '--verify-tag', kind, '--title', pkg.name.split('/').pop() + ' ' + pkg.version, '--notes-file', '-'], { encoding: 'utf8', timeout: 120_000, input: notes });
if (ghRelease.status === 0) console.log('GitHub release ' + tag + ' created (' + elapsed() + ')');
else if (/already.exists/.test(ghRelease.stderr)) console.log('GitHub release ' + tag + ' already exists');
else throw new Error('gh release create ' + tag + '\n' + (ghRelease.stderr || ghRelease.error));
verifyInstall();
function verifyInstall() {
  const prefix = resolve(scratch, 'installed-' + pkg.version);
  // Online: this machine's cached packument predates the publish and answers ETARGET.
  run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--prefer-online', pkg.name + '@' + pkg.version], { stdio: 'inherit' });
  // The `browser` command as npm links it; postinstall made it the native binary.
  const installed = prefix + '/node_modules/@phnx-labs/browser-cli';
  if (readFileSync(installed + '/bin/browser.cjs').subarray(0, 2).toString() === '#!') throw new Error('postinstall left the JavaScript launcher in place of the native binary');
  const command = prefix + '/node_modules/.bin/browser';
  const version = run(command, ['--version']);
  if (version !== pkg.version) throw new Error('Installed version mismatch: ' + version);
  run(command, ['--help']);
  const skills = run(command, ['skills', 'path']);
  if (realpathSync(skills) !== realpathSync(installed + '/skills/browser')) throw new Error('Installed skill path is ' + skills);
  console.log('Registry install verified: browser ' + version + ' (' + elapsed() + '). Verify live browser actions before declaring delivery complete.');
}
