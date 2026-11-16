import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareVersions } from './semver.js';
import { getBrowserRuntimeDir } from './state.js';
import { versionSkewNotice } from '../browser/ipc.js';

export const PACKAGE_NAME = '@phnx-labs/browser-cli';
export const NOTIFIER_OPT_OUT = 'BROWSER_NO_UPDATE_NOTIFIER';
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;
const MARK = '@@browser-doctor ';

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export type ShellName = 'zsh' | 'bash' | 'fish';

export interface RcLocation {
  file: string;
  line: number;
  text: string;
}

export interface ShellResolution {
  shell: ShellName;
  kind: 'alias' | 'function' | 'file' | 'builtin' | 'none';
  definition?: string;
  definedAt?: RcLocation;
  executable?: string;
  path: string[];
}

export interface PathCopy {
  file: string;
  version?: string;
  self: boolean;
  wins: boolean;
}

export interface Shadow {
  shell: ShellName;
  kind: 'alias' | 'function' | 'file';
  summary: string;
  fix: string;
  definedAt?: RcLocation;
  executable?: string;
}

export interface InstallMethod {
  method: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'brew' | 'unknown';
  upgrade: string;
  uninstall: string;
  binDir: string;
}

const PROBES: Record<ShellName, string> = {
  zsh: [
    'w=$(whence -w browser 2>/dev/null); k=${w##*: }',
    `print -r -- "${MARK}kind \${k:-none}"`,
    `[[ $k == alias ]] && print -r -- "${MARK}def \${aliases[browser]}"`,
    `[[ $k == function ]] && print -r -- "${MARK}src \${functions_source[browser]}"`,
    `print -r -- "${MARK}exe $(whence -p browser 2>/dev/null)"`,
    `print -r -- "${MARK}PATH $PATH"`,
  ].join('\n'),
  bash: [
    't=$(type -t browser 2>/dev/null)',
    `echo "${MARK}kind \${t:-none}"`,
    `[ "$t" = alias ] && echo "${MARK}def \${BASH_ALIASES[browser]}"`,
    `if [ "$t" = function ]; then shopt -s extdebug; read -r _ l f < <(declare -F browser); echo "${MARK}src $f"; echo "${MARK}line $l"; fi`,
    `echo "${MARK}exe $(type -P browser 2>/dev/null)"`,
    `echo "${MARK}PATH $PATH"`,
  ].join('\n'),
  fish: [
    'set -l t (type -t browser 2>/dev/null)',
    `echo "${MARK}kind $t"`,
    `test "$t" = function; and echo "${MARK}src "(functions --details browser)`,
    `echo "${MARK}exe "(command -s browser)`,
    `echo "${MARK}PATH "(string join : $PATH)`,
  ].join('\n'),
};

export function shellName(shell: string | undefined): ShellName | undefined {
  const base = path.basename(shell ?? '').replace(/^-/, '');
  return base === 'zsh' || base === 'bash' || base === 'fish' ? base : undefined;
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

export function tildify(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const h = home(env);
  return file === h || file.startsWith(h + path.sep) ? '~' + file.slice(h.length) : file;
}

function withoutPackageManagerBins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.npm_lifecycle_event) return env;
  const PATH = (env.PATH ?? '').split(path.delimiter)
    .filter((dir) => !/[\\/]node_modules[\\/]\.bin$|node-gyp-bin$|[\\/]bun-node-[^\\/]*$/.test(dir))
    .join(path.delimiter);
  return { ...env, PATH };
}

/** Output to a file, not a pipe, in its own process group: nothing the rc leaves running can hold this past the timeout. */
async function runBounded(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; timedOut: boolean; error?: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-doctor-'));
  const fd = fs.openSync(path.join(dir, 'out'), 'w', 0o600);
  try {
    const ended = await new Promise<{ timedOut: boolean; error?: string }>((resolve) => {
      const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, 'ignore'], env });
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
        resolve({ timedOut: true });
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); resolve({ timedOut: false, error: err.message }); });
      child.on('exit', () => { clearTimeout(timer); resolve({ timedOut: false }); });
    });
    return { ...ended, stdout: fs.readFileSync(path.join(dir, 'out'), 'utf8') };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function resolveInShell(
  shell: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ShellResolution | { error: string }> {
  const name = shellName(shell);
  if (!name) return { error: `${shell || '$SHELL'} is not zsh, bash or fish` };
  const login = name === 'zsh' || (name === 'bash' && process.platform === 'darwin');
  const probe = await runBounded(shell, [...(login ? ['-l'] : []), '-i', '-c', PROBES[name]], { ...withoutPackageManagerBins(env), [NOTIFIER_OPT_OUT]: '1' }, timeoutMs);
  if (probe.error && !probe.stdout) return { error: `could not run ${shell}: ${probe.error}` };
  const fields = new Map<string, string>();
  for (const line of probe.stdout.split('\n')) {
    if (!line.startsWith(MARK)) continue;
    const rest = line.slice(MARK.length);
    const space = rest.indexOf(' ');
    fields.set(space < 0 ? rest : rest.slice(0, space), space < 0 ? '' : rest.slice(space + 1));
  }
  if (!fields.has('kind')) {
    return { error: `${name} gave no answer${probe.timedOut ? ` within ${timeoutMs / 1000}s` : ''}` };
  }
  const raw = fields.get('kind') || 'none';
  const kind: ShellResolution['kind'] = raw === 'alias' || raw === 'function' || raw === 'builtin' || raw === 'none'
    ? raw
    : raw === 'keyword' || raw === 'reserved' ? 'builtin' : 'file';
  const resolution: ShellResolution = {
    shell: name,
    kind,
    executable: fields.get('exe') || undefined,
    path: (fields.get('PATH') ?? '').split(':').filter(Boolean),
  };
  if (kind === 'alias') {
    resolution.definition = fields.get('def');
    resolution.definedAt = findRcDefinition(name, 'alias', env);
  } else if (kind === 'function') {
    const src = fields.get('src');
    const file = src && path.isAbsolute(src) ? src : undefined;
    const line = Number(fields.get('line'));
    resolution.definedAt = file && line > 0
      ? { file, line, text: readLine(file, line) }
      : findRcDefinition(name, 'function', env, file);
  }
  return resolution;
}

function readLine(file: string, line: number): string {
  try {
    return (fs.readFileSync(file, 'utf8').split('\n')[line - 1] ?? '').trim();
  } catch {
    return '';
  }
}

export function startupFiles(shell: ShellName, env: NodeJS.ProcessEnv = process.env): string[] {
  const h = home(env);
  if (shell === 'zsh') {
    const dot = env.ZDOTDIR || h;
    return ['zshenv', 'zprofile', 'zshrc', 'zlogin'].flatMap((stage) => [`/etc/${stage}`, `/etc/zsh/${stage}`, path.join(dot, `.${stage}`)]);
  }
  if (shell === 'bash') {
    if (process.platform !== 'darwin') return ['/etc/bash.bashrc', '/etc/bashrc', path.join(h, '.bashrc')];
    const personal = ['.bash_profile', '.bash_login', '.profile'].map((f) => path.join(h, f)).find((f) => fs.existsSync(f));
    return ['/etc/profile', ...(personal ? [personal] : [])];
  }
  const config = path.join(env.XDG_CONFIG_HOME || path.join(h, '.config'), 'fish');
  let confd: string[] = [];
  try {
    confd = fs.readdirSync(path.join(config, 'conf.d')).filter((f) => f.endsWith('.fish')).sort().map((f) => path.join(config, 'conf.d', f));
  } catch {}
  return [...confd, path.join(config, 'config.fish'), path.join(config, 'functions', 'browser.fish')];
}

const ALIAS_LINE = /^\s*alias\s+(?:-[a-zA-Z]+\s+)*['"]?browser(?:=|['"]?\s)/;
const FUNCTION_LINE = /^\s*(?:function\s+browser\b|browser\s*\(\s*\))/;
const SOURCE_LINE = /(?:^\s*|[;&|{]\s*|\bthen\s+)(?:source|\.)\s+(\S+)/;

function expandSourced(word: string, from: string, env: NodeJS.ProcessEnv): string | undefined {
  const h = home(env);
  const expanded = word.replace(/^['"]|['"]$/g, '')
    .replace(/^~(?=\/|$)/, h)
    .replace(/\$\{ZDOTDIR:-\$HOME\}|\$\{ZDOTDIR\}|\$ZDOTDIR\b/g, env.ZDOTDIR || h)
    .replace(/\$\{HOME\}|\$HOME\b/g, h);
  if (/[$*?`]/.test(expanded)) return undefined;
  return path.isAbsolute(expanded) ? expanded : path.join(path.dirname(from), expanded);
}

/** The last place the startup files define `browser`, following `source` lines; the last definition is the one in force. */
export function findRcDefinition(
  shell: ShellName,
  kind: 'alias' | 'function',
  env: NodeJS.ProcessEnv = process.env,
  onlyFile?: string,
): RcLocation | undefined {
  const matches = (line: string) => shell === 'fish'
    ? ALIAS_LINE.test(line) || FUNCTION_LINE.test(line)
    : (kind === 'alias' ? ALIAS_LINE : FUNCTION_LINE).test(line);
  const seen = new Set<string>();
  let found: RcLocation | undefined;
  const scan = (file: string, depth: number) => {
    if (depth > 8 || seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      if (matches(line)) found = { file, line: i + 1, text: line.trim() };
      const sourced = SOURCE_LINE.exec(line)?.[1];
      const target = sourced ? expandSourced(sourced, file, env) : undefined;
      if (target) scan(target, depth + 1);
    });
  };
  for (const file of onlyFile ? [onlyFile] : startupFiles(shell, env)) scan(file, 0);
  return found;
}

export function selfExecutables(env: NodeJS.ProcessEnv = process.env): string[] {
  const binary = runningBinary();
  const out: string[] = binary ? [binary] : [];
  if (env.BROWSER_SKILLS_DIR) out.push(path.join(env.BROWSER_SKILLS_DIR, '..', 'bin', 'browser.cjs'));
  return out;
}

function fileIdentity(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

export function isSameFile(a: string, b: string): boolean {
  const id = fileIdentity(a);
  return id !== undefined && id === fileIdentity(b);
}

const PACKAGE_ENTRY = /[^"'\s]*node_modules[\\/]@phnx-labs[\\/]browser-cli[\\/]bin[\\/]browser\.cjs/g;

export function launcherTarget(file: string): string | undefined {
  const dir = path.dirname(file);
  const bunx = path.join(dir, path.basename(file, path.extname(file)) + '.bunx');
  let text: string;
  try {
    if (/\.exe$/i.test(file)) text = fs.readFileSync(bunx).toString('utf16le');
    else if (fs.statSync(file).size > 64 * 1024) return undefined;
    else text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const targets = [...text.matchAll(PACKAGE_ENTRY)].map(([raw]) => path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.join(dir, ...raw.replace(/^(?:%~?dp0%?|\$basedir|\$PSScriptRoot)(?=[\\/])/, '').split(/[\\/]+/).filter(Boolean)));
  return targets.find((target) => fs.existsSync(target)) ?? targets[0];
}

function isThisInstall(file: string, self: string[]): boolean {
  const target = launcherTarget(file);
  return self.some((s) => isSameFile(s, file) || (target !== undefined && isSameFile(s, target)));
}

export function probeVersion(file: string): string | undefined {
  const run = spawnSync(file, ['--version'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [NOTIFIER_OPT_OUT]: '1' },
  });
  const first = (run.stdout ?? '').trim().split('\n')[0]?.trim() ?? '';
  return /^v?\d+\.\d+/.test(first) ? first.replace(/^v/, '') : undefined;
}

function* executablesOnPath(dirs: string[], platform: NodeJS.Platform): Generator<string> {
  const names = platform === 'win32' ? ['browser.exe', 'browser.cmd'] : ['browser'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
        fs.accessSync(file, fs.constants.X_OK);
      } catch {
        continue;
      }
      yield file;
    }
  }
}

export function browsersOnPath(dirs: string[], self: string[], selfVersion: string, platform = process.platform): PathCopy[] {
  const copies: PathCopy[] = [];
  const seen = new Set<string>();
  for (const file of executablesOnPath(dirs, platform)) {
    const id = fileIdentity(file)!;
    if (seen.has(id)) continue;
    seen.add(id);
    const isSelf = isThisInstall(file, self);
    copies.push({ file, self: isSelf, wins: copies.length === 0, version: isSelf ? selfVersion : probeVersion(file) });
  }
  return copies;
}

export function installMethod(file: string): InstallMethod {
  let real = launcherTarget(file) ?? file;
  try {
    real = fs.realpathSync(real);
  } catch {}
  const unix = real.split(path.sep).join('/');
  const cellar = /\/Cellar\/([^/]+)\//.exec(unix);
  if (cellar) return { method: 'brew', upgrade: `brew upgrade ${cellar[1]}`, uninstall: `brew uninstall ${cellar[1]}`, binDir: path.dirname(file) };
  if (unix.includes('/.bun/install/global/')) {
    return { method: 'bun', upgrade: `bun add -g ${PACKAGE_NAME}@latest`, uninstall: `bun remove -g ${PACKAGE_NAME}`, binDir: path.join(unix.split('/.bun/')[0], '.bun', 'bin') };
  }
  const pnpm = /^(.*?)\/global\/\d+\/(?:\.pnpm|node_modules)\//.exec(unix);
  if (pnpm) return { method: 'pnpm', upgrade: `pnpm add -g ${PACKAGE_NAME}@latest`, uninstall: `pnpm remove -g ${PACKAGE_NAME}`, binDir: pnpm[1] };
  if (/\/yarn\/global\/node_modules\//.test(unix)) {
    return { method: 'yarn', upgrade: `yarn global add ${PACKAGE_NAME}@latest`, uninstall: `yarn global remove ${PACKAGE_NAME}`, binDir: path.dirname(file) };
  }
  const npm = /^(.*)\/lib\/node_modules\/@phnx-labs\/browser-cli/.exec(unix);
  if (npm || unix.includes('/node_modules/@phnx-labs/browser-cli')) {
    const prefix = npm ? ` --prefix ${npm[1]}` : '';
    return {
      method: 'npm',
      upgrade: `npm install -g${prefix} ${PACKAGE_NAME}@latest`,
      uninstall: `npm uninstall -g${prefix} ${PACKAGE_NAME}`,
      binDir: npm ? path.join(npm[1], 'bin') : path.dirname(file),
    };
  }
  return { method: 'unknown', upgrade: `npm install -g ${PACKAGE_NAME}@latest`, uninstall: `rm ${file}`, binDir: path.dirname(file) };
}

const UNSET: Record<ShellName, Record<'alias' | 'function', string>> = {
  zsh: { alias: 'unalias browser', function: 'unfunction browser' },
  bash: { alias: 'unalias browser', function: 'unset -f browser' },
  fish: { alias: 'functions -e browser', function: 'functions -e browser' },
};

export function findShadow(resolution: ShellResolution, self: string[], env: NodeJS.ProcessEnv = process.env): Shadow | undefined {
  const { shell } = resolution;
  if (resolution.kind === 'alias' || resolution.kind === 'function') {
    const at = resolution.definedAt;
    const where = at ? `${tildify(at.file, env)}:${at.line}` : `your ${shell} startup files`;
    const what = resolution.kind === 'alias' ? `the alias browser='${resolution.definition ?? ''}'` : 'a shell function named browser';
    const remove = at ? `delete line ${at.line} of ${tildify(at.file, env)} (${at.text})` : `remove the browser ${resolution.kind} from ${where}`;
    return {
      shell,
      kind: resolution.kind,
      definedAt: at,
      summary: `${shell} runs ${what} from ${where}, not this install`,
      fix: `${remove}, then run \`${UNSET[shell][resolution.kind]}\` in shells already open`,
    };
  }
  const other = resolution.executable;
  if (resolution.kind !== 'file' || !other || self.length === 0 || isThisInstall(other, self)) return undefined;
  const version = probeVersion(other);
  return {
    shell,
    kind: 'file',
    executable: other,
    summary: `${shell} runs ${other}${version ? ` (${version})` : ''}, not this install (${self[0]})`,
    fix: `remove that copy with \`${installMethod(other).uninstall}\`, or put ${installMethod(self[0]).binDir} before ${path.dirname(other)} in PATH`,
  };
}

export function shadowStillPresent(shadow: Shadow, env: NodeJS.ProcessEnv = process.env): boolean {
  if (shadow.kind === 'file') {
    const [first] = executablesOnPath((env.PATH ?? '').split(path.delimiter).filter(Boolean), process.platform);
    return Boolean(first && shadow.executable && isSameFile(first, shadow.executable));
  }
  if (!shadow.definedAt) return true;
  return readLine(shadow.definedAt.file, shadow.definedAt.line) === shadow.definedAt.text;
}

export async function latestRelease(timeoutMs = 3_000): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export interface InstallCheckCache {
  checkedAt: number;
  self?: string;
  latest?: string;
  shadow?: Shadow;
  hub?: { device: string; version?: string };
}

export function installCheckCachePath(): string {
  return path.join(getBrowserRuntimeDir(), 'install-check.json');
}

export function readInstallCheckCache(): InstallCheckCache | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(installCheckCachePath(), 'utf8')) as InstallCheckCache;
    return typeof parsed.checkedAt === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeInstallCheckCache(cache: InstallCheckCache): boolean {
  try {
    const file = installCheckCachePath();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CI || env.BUILD_NUMBER || env.RUN_ID);
}

export function noticeAllowed(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  tty = { stdout: Boolean(process.stdout.isTTY), stderr: Boolean(process.stderr.isTTY) },
): boolean {
  if (env[NOTIFIER_OPT_OUT] || env.CODESPACES || isCI(env)) return false;
  return tty.stdout && tty.stderr && !argv.includes('--json');
}

export function noticeLine(
  cache: InstallCheckCache,
  current: string,
  self: string[],
  hubDevice?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const hide = `${NOTIFIER_OPT_OUT}=1 hides this`;
  const sameInstall = (cache.self ?? '') === (self[0] ?? '');
  if (sameInstall && cache.shadow && shadowStillPresent(cache.shadow, env)) {
    return `browser: ${cache.shadow.summary}. Run \`browser doctor\` for the fix (${hide}).`;
  }
  const upgrade = installMethod(self[0] ?? '').upgrade;
  const hub = sameInstall && cache.hub && cache.hub.device === hubDevice && versionSkewNotice(cache.hub.version, current, { device: cache.hub.device, upgrade });
  if (hub) return `browser: ${hub} (${hide}).`;
  if (cache.latest && compareVersions(cache.latest, current) > 0) {
    return `A new release of browser is available: ${current} → ${cache.latest}. To upgrade, run: ${upgrade} (${hide}).`;
  }
  return undefined;
}

export function installNotice(argv: string[], current: string, refreshArgv: string[], hubDevice?: string): void {
  if (!noticeAllowed(argv)) return;
  const cache = readInstallCheckCache();
  if (!cache || Date.now() - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const [cmd, ...args] = refreshArgv;
    if (writeInstallCheckCache({ ...cache, checkedAt: Date.now() })) {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, [NOTIFIER_OPT_OUT]: '1' } });
        child.on('error', () => {});
        child.unref();
      } catch {}
    }
  }
  const line = cache && noticeLine(cache, current, selfExecutables(), hubDevice);
  if (line) process.stderr.write(line + '\n');
}

export function runningBinary(): string | undefined {
  return /^(bun|node)(\.exe)?$/.test(path.basename(process.execPath)) ? undefined : process.execPath;
}

export interface InstallHealth {
  checks: DoctorCheck[];
  shell?: ShellResolution;
  onPath: PathCopy[];
  shadow?: Shadow;
  latest?: string;
  hub?: { device: string; version?: string };
}

export interface InstallHealthOptions {
  current: string;
  local?: boolean;
  env?: NodeJS.ProcessEnv;
  self?: string[];
  hub?: { device: string; version: () => Promise<{ version?: string; error?: string }> };
}

export async function checkInstallHealth(opts: InstallHealthOptions): Promise<InstallHealth> {
  const env = opts.env ?? process.env;
  const self = opts.self ?? selfExecutables(env);
  const upgrade = installMethod(self[0] ?? '').upgrade;
  const checks: DoctorCheck[] = [];
  const health: InstallHealth = { checks, onPath: [] };

  const resolved = process.platform === 'win32'
    ? { error: 'Windows shells are not checked' }
    : await resolveInShell(env.SHELL ?? '', env);
  if ('error' in resolved) {
    checks.push({ label: 'shell', ok: true, detail: `not checked: ${resolved.error}` });
  } else {
    health.shell = resolved;
    health.shadow = findShadow(resolved, self, env);
    const name = resolved.shell;
    if (health.shadow) {
      checks.push({ label: 'shell', ok: false, detail: health.shadow.summary, fix: health.shadow.fix });
    } else if (resolved.kind === 'none') {
      checks.push({
        label: 'shell', ok: false, detail: `${name} finds no browser command`,
        ...(self[0] ? { fix: `add ${installMethod(self[0]).binDir} to PATH in your ${name} startup file` } : {}),
      });
    } else if (resolved.kind === 'builtin') {
      checks.push({ label: 'shell', ok: false, detail: `${name} treats browser as a builtin or keyword` });
    } else {
      const tag = self.length ? '(this install)' : '(this process runs from source, so it is not compared)';
      checks.push({ label: 'shell', ok: true, detail: `${name} runs ${resolved.executable} ${tag}` });
    }
  }

  const dirs = health.shell?.path.length ? health.shell.path : (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  health.onPath = browsersOnPath(dirs, self, opts.current);
  const winner = health.onPath[0];
  for (const copy of health.onPath) {
    const role = copy.wins ? 'wins' : `shadowed by ${winner.file}`;
    const detail = `${copy.file} ${copy.version ?? '(no version)'}${copy.self ? ' (this install)' : ''}, ${role}`;
    const stale = !copy.self && self.length > 0 && (copy.wins || copy.version !== opts.current);
    const fixedAbove = health.shadow?.kind === 'file' && copy.wins;
    checks.push(!stale
      ? { label: 'path', ok: true, detail }
      : fixedAbove
        ? { label: 'path', ok: false, detail }
        : { label: 'path', ok: false, detail, fix: `remove it with \`${installMethod(copy.file).uninstall}\`${copy.wins ? '' : '; agents and scripts with another PATH still run it'}` });
  }
  if (health.onPath.length === 0) checks.push({ label: 'path', ok: false, detail: 'no browser executable on PATH' });
  else if (self.length > 0 && !health.onPath.some((c) => c.self) && health.shadow?.kind !== 'file') {
    checks.push({ label: 'path', ok: false, detail: `this install (${self[0]}) is not on PATH`, fix: `add ${installMethod(self[0]).binDir} to PATH, before ${path.dirname(winner.file)}` });
  }
  if (opts.local) return health;

  health.latest = await latestRelease();
  if (!health.latest) {
    checks.push({ label: 'version', ok: true, detail: `${opts.current}; not compared: registry.npmjs.org did not answer` });
  } else if (compareVersions(health.latest, opts.current) > 0) {
    checks.push({ label: 'version', ok: false, detail: `${opts.current}, but ${health.latest} is out`, fix: upgrade });
  } else {
    checks.push({ label: 'version', ok: true, detail: `${opts.current} is the latest release` });
  }

  if (!opts.hub) {
    checks.push({ label: 'hub', ok: true, detail: 'browser.device is not set; commands run on this machine' });
    return health;
  }
  const { version, error } = await opts.hub.version();
  health.hub = { device: opts.hub.device, version };
  const notice = version ? versionSkewNotice(version, opts.current, { device: opts.hub.device, upgrade }) : undefined;
  if (!version) {
    checks.push({ label: 'hub', ok: false, detail: `could not read the browser version on ${opts.hub.device}: ${error ?? 'no answer'}` });
  } else if (notice) {
    checks.push({ label: 'hub', ok: false, detail: notice });
  } else {
    checks.push({ label: 'hub', ok: true, detail: `${opts.hub.device} (browser.device) runs ${version}, same as this machine` });
  }
  return health;
}
