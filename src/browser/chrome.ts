import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProfileRuntimeDir } from './profiles.js';
import { CDPClient, discoverBrowserWsUrl, type BrowserDiscovery } from './cdp.js';
import { readAndResolveBundleEnv, bundleExists } from '../runtime/secrets.js';
import { writeProfileRuntime, readProfileRuntime } from './runtime-state.js';
import type { ChromeOptions } from './types.js';
import type { Readable, Writable } from 'stream';

import type { BrowserType } from './types.js';

// Windows install roots. Resolve from the environment (fall back to the usual
// defaults) so per-user installs under %LOCALAPPDATA% and 64-bit Program Files
// are found, not just the hardcoded x86 path. Only the `win32` entries below use
// these; on other platforms they compute unused placeholder strings.
const WIN_PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files';
const WIN_PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const WIN_LOCALAPPDATA = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;

const BROWSER_PATHS: Record<string, Record<BrowserType, string[]>> = {
  darwin: {
    chrome: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    comet: ['/Applications/Comet.app/Contents/MacOS/Comet'],
    chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    arc: ['/Applications/Arc.app/Contents/MacOS/Arc'],
    firefox: [
      '/Applications/Firefox.app/Contents/MacOS/firefox',
      '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    ],
    custom: [],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    comet: [],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    edge: ['/usr/bin/microsoft-edge'],
    // Arc has no Linux build (macOS + Windows only).
    arc: [],
    // `/usr/bin/firefox` on Ubuntu is the snap wrapper script: it execs the snap
    // in place, so the pid survives and `--remote-debugging-port` works through
    // it. The driver reads the real pid from the BiDi handshake anyway.
    firefox: ['/usr/bin/firefox', '/snap/bin/firefox', '/usr/lib/firefox/firefox', '/opt/firefox/firefox'],
    custom: [],
  },
  win32: {
    chrome: [
      `${WIN_PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${WIN_PROGRAMFILES_X86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${WIN_LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    comet: [
      `${WIN_PROGRAMFILES}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${WIN_PROGRAMFILES_X86}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${WIN_LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
    ],
    chromium: [
      `${WIN_LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
    ],
    brave: [
      `${WIN_PROGRAMFILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${WIN_PROGRAMFILES_X86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${WIN_LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ],
    edge: [
      `${WIN_PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${WIN_PROGRAMFILES_X86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${WIN_LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    // Arc ships a Windows build, but its install path is not yet verified here;
    // leave unlisted (undetected) rather than guess a path that false-positives.
    arc: [],
    firefox: [
      `${WIN_PROGRAMFILES}\\Mozilla Firefox\\firefox.exe`,
      `${WIN_PROGRAMFILES_X86}\\Mozilla Firefox\\firefox.exe`,
      `${WIN_LOCALAPPDATA}\\Mozilla Firefox\\firefox.exe`,
    ],
    custom: [],
  },
};


/**
 * Debian/Ubuntu `/usr/bin` launchers are bash wrappers that run the real ELF as a non-exec
 * child, breaking the CDP pipe on fd 3/4; resolveBrowserBinary follows them to that ELF.
 */
function readsAsShebangScript(binaryPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(binaryPath, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    // ELF binaries start with 0x7f 'E'; shebang scripts with '#!'.
    return head[0] === 0x23 && head[1] === 0x21;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * True when `binaryPath` is a shebang script, which `launchBrowser` cannot drive over
 * `--remote-debugging-pipe`; `profiles doctor` flags a wrapper we could not unwrap.
 */
export function isLauncherScript(binaryPath: string): boolean {
  if (os.platform() === 'win32') return false;
  return readsAsShebangScript(binaryPath);
}

export function resolveBrowserBinary(binaryPath: string): string {
  if (os.platform() !== 'linux') return binaryPath;
  // Only shebang scripts need unwrapping; a real ELF passes straight through.
  if (!readsAsShebangScript(binaryPath)) return binaryPath;

  let script: string;
  let realScriptPath: string;
  try {
    realScriptPath = fs.realpathSync(binaryPath);
    script = fs.readFileSync(realScriptPath, 'utf8');
  } catch {
    return binaryPath;
  }
  // Match the Chromium wrapper's launch line: `"$HERE/<name>" "$@"`, optionally
  // prefixed with `exec -a "$0"`. The captured name is the real ELF, sitting in
  // the same directory as the resolved wrapper.
  const match = script.match(/"\$HERE\/([A-Za-z0-9._-]+)"\s+"\$@"/);
  if (!match) return binaryPath;
  const realBinary = path.join(path.dirname(realScriptPath), match[1]);
  return fs.existsSync(realBinary) ? realBinary : binaryPath;
}

export function findBrowserPath(browserType: BrowserType, customBinary?: string): string {
  if (customBinary) {
    if (!fs.existsSync(customBinary)) {
      throw new Error(`Custom binary not found: ${customBinary}`);
    }
    return resolveBrowserBinary(customBinary);
  }

  if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  }

  const platform = os.platform();
  const platformPaths = BROWSER_PATHS[platform];
  if (!platformPaths) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const candidates = platformPaths[browserType] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return resolveBrowserBinary(p);
    }
  }

  if (browserType === 'comet' && platform === 'linux') {
    throw new Error('Browser "comet" is not available on Linux (Comet ships macOS and Windows builds only). Use chrome, chromium, brave, or edge on this platform.');
  }
  if (browserType === 'arc' && platform === 'linux') {
    throw new Error('Browser "arc" is not available on Linux (Arc ships macOS and Windows builds only). Use chrome, chromium, brave, or edge on this platform.');
  }
  throw new Error(`Browser "${browserType}" not found. Install it first.`);
}

// Chromium-family auto-pick order for "no --profile", most likely installed first.
// Firefox is absent: it has its own BiDi driver (drivers/firefox.ts) and profiles.ini
// discovery. Safari has no driver at all.
const DEFAULT_BROWSER_PRIORITY: Record<string, BrowserType[]> = {
  // macOS: Chrome leads (>70% of dev machines), then the rest of the family.
  // Arc is last: it's in maintenance mode and needs a blank tab to drive, so it
  // shouldn't win auto-pick over a mainstream browser.
  darwin: ['chrome', 'brave', 'edge', 'chromium', 'comet', 'arc'],
  // Linux: Chrome/Chromium first (apt/snap), then Brave/Edge if present.
  linux: ['chrome', 'chromium', 'brave', 'edge'],
  // Windows: Edge is preinstalled on every supported build, so it's the
  // reliable always-there default.
  win32: ['edge', 'chrome', 'brave', 'comet'],
};

/** Installed Chromium-family browsers on this machine, in platform priority order. */
export function listInstalledBrowsers(
  platform: string = os.platform()
): { browserType: BrowserType; binary: string }[] {
  const priority = DEFAULT_BROWSER_PRIORITY[platform];
  const platformPaths = BROWSER_PATHS[platform];
  if (!priority || !platformPaths) return [];
  const found: { browserType: BrowserType; binary: string }[] = [];
  for (const browserType of priority) {
    const candidates = platformPaths[browserType] || [];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        found.push({ browserType, binary: resolveBrowserBinary(p) });
        break; // one install path per browser type is enough
      }
    }
  }
  return found;
}

export interface LaunchResult {
  pid: number;
  port: number;
  cdp: CDPClient;
}

/**
 * The pid that holds a Chromium user-data dir (its `SingletonLock` symlink), or null. A launch
 * on an owned store hands off to that browser and never binds the port. Windows keeps no lock.
 */
export function storeOccupant(userDataDir: string): { pid: number } | null {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
  } catch {
    return null;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? { pid } : null;
  }
  return { pid };
}

/**
 * The relaunch that makes a browser holding `userDataDir` attachable: the ownership guard
 * reads `--user-data-dir` off the process, so the owner's normal launch can't be verified.
 */
export function storeRelaunchCommand(browserType: BrowserType, port: number, userDataDir: string, profileDirectory?: string): string {
  const app = browserType === 'comet' ? 'Comet' : browserType;
  const profileFlag = profileDirectory ? ` --profile-directory=${profileDirectory}` : '';
  return `open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${userDataDir}${profileFlag}`;
}

/**
 * A profile's secrets bundle as the child's env, or {} when absent, locked or unreadable.
 * The read is `agentOnly` and never prompts: a launch is background work, not a human at Touch ID.
 */
export async function resolveProfileSecretsEnv(secrets?: string): Promise<Record<string, string>> {
  if (!secrets || !(await bundleExists(secrets))) return {};
  try {
    const { env } = await readAndResolveBundleEnv(secrets, { caller: 'browser profile', agentOnly: true });
    return env;
  } catch {
    // Bundle locked or failed to resolve — launch without secrets (no prompt).
    return {};
  }
}

/**
 * `--password-store=basic` for a headless managed browser on Linux, where a locked gnome-keyring
 * stalls every http(s) load. Other stores keep their keyring; a once-headed profile signs in again.
 */
export function headlessKeyringArgs(opts: {
  headless: boolean;
  platform: NodeJS.Platform;
  isElectron: boolean;
  ownerStore: boolean;
}): string[] {
  return opts.headless && opts.platform === 'linux' && !opts.isElectron && !opts.ownerStore
    ? ['--password-store=basic']
    : [];
}

export async function launchBrowser(
  profileName: string,
  browserType: BrowserType,
  port: number,
  options: ChromeOptions = {},
  secrets?: string,
  customBinary?: string,
  // `electron: true` distinguishes Notion / VS Code-style apps from
  // regular Chrome — purely informational, stored in meta.json so the
  // orphan reaper and `browser status` can label processes.
  isElectron: boolean = false
): Promise<LaunchResult> {
  const browserPath = findBrowserPath(browserType, customBinary);

  // A profile discovered from the browser's OWN store (PHNX-4042) launches on
  // that store — the owner's real user-data dir and profile directory — so the
  // window agents open is the window the owner uses. Its Preferences are the
  // owner's and are never rewritten. Anything else runs under a managed dir.
  const ownerStore = options.userDataDir !== undefined;
  const runtimeDir = getProfileRuntimeDir(profileName);
  const userDataDir = options.userDataDir ?? path.join(runtimeDir, 'chrome-data');
  if (!ownerStore) {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Pre-launch Preferences pass: first-launch profile-name stamp, plus (for
    // real browsers, not Electron apps) the session-cookie persistence pin.
    // Electron apps manage their own storage and don't read Chromium's
    // `session.*` prefs, so they get the name stamp only.
    ensureProfilePreferences(userDataDir, profileName, !isElectron);
  }
  // The owner's store is attached over a TCP port rather than the daemon's
  // private pipe: the instance outlives any one daemon and must stay reachable
  // (and verifiable by the ownership guard) after a daemon restart.
  const transport: 'pipe' | 'port' = ownerStore ? 'port' : 'pipe';

  // A direct spawn with a fresh --user-data-dir runs apart from the user's browser (Chromium's
  // SingletonLock is per dir), but on macOS it gets its own Dock tile, so an attach-only
  // profile never reaches this launcher (see connectLocal / isAttachOnlyProfile).

  const viewport = options.viewport ?? { width: 1512, height: 982 };
  const args = [
    transport === 'pipe' ? '--remote-debugging-pipe' : `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...(options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : []),
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // First-run + default-browser modals block automation: when targetFilter
    // matches by URL, the onboarding page (`chrome://welcome/`) isn't a
    // match and start fails with "no page target". Suppress them.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DefaultBrowserSetting,ChromeWhatsNewUI',
    '--disable-crash-reporter',
    // Suppress navigator.webdriver = true, which Chromium sets whenever a
    // remote-debugging transport is active. That property is the loudest
    // signal Cloudflare Turnstile, hCaptcha, and similar checks read.
    '--disable-blink-features=AutomationControlled',
    // Pairs with `session.restore_on_startup: 1` (ensureProfilePreferences): cookies survive a
    // restart without reopening last session's tabs. Electron apps need their window for the
    // CDP driver, so they skip it.
    ...(isElectron || ownerStore ? [] : ['--no-startup-window']),
    ...(options.headless ? ['--headless=new'] : []),
    ...headlessKeyringArgs({ headless: Boolean(options.headless), platform: process.platform, isElectron, ownerStore }),
    `--window-size=${viewport.width},${viewport.height}`,
    ...(viewport.x !== undefined && viewport.y !== undefined
      ? [`--window-position=${viewport.x},${viewport.y}`]
      : []),
    ...(options.args || []),
  ];

  // Profile secrets: agentOnly (SEC-13) — a locked bundle resolves to an empty map
  // (launch proceeds without them), never a Touch ID prompt. See resolveProfileSecretsEnv.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(await resolveProfileSecretsEnv(secrets)) };

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: transport === 'pipe' ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env,
  });
  child.unref();
  child.stdout?.resume();
  const launchExit = watchLaunchExit(child, browserType);

  const pid = child.pid!;
  const cdp = new CDPClient();
  try {
    if (transport === 'pipe') {
      const writePipe = child.stdio[3] as Writable | null;
      const readPipe = child.stdio[4] as Readable | null;
      if (!writePipe || !readPipe) {
        throw new Error('Chrome failed to expose CDP pipe file descriptors');
      }
      cdp.connectPipe({ read: readPipe, write: writePipe });
      // The pipe exists as soon as the process does; only an answer proves the browser came up.
      await Promise.race([cdp.send('Browser.getVersion'), launchExit.exited.then((error) => Promise.reject(error))]);
    } else {
      const { wsUrl } = await waitForDevToolsPort(port, profileName, child, launchExit.exited, {
        browserType,
        userDataDir,
        profileDirectory: options.profileDirectory,
      });
      await cdp.connect(wsUrl);
    }
  } catch (error) {
    cdp.close();
    // A dying browser closes the pipe a moment before its exit is reported; prefer its own reason.
    // The port path's error already carries it.
    if (transport === 'pipe') throw (await Promise.race([launchExit.exited, delay(2_000)])) ?? error;
    throw error;
  } finally {
    launchExit.stopCapture();
  }

  writeProfileRuntime(profileName, {
    pid,
    command: path.basename(browserPath),
    userDataDir,
    kind: isElectron ? 'electron' : 'browser',
  });

  return { pid, port: transport === 'pipe' ? 0 : port, cdp };
}

/**
 * Poll a just-launched browser's DevTools port until it answers, or fail naming the pid. A child
 * that exits first handed off to a browser already on that store, so the error names its relaunch.
 */
async function waitForDevToolsPort(
  port: number,
  profileName: string,
  child: ChildProcess,
  exited: Promise<Error>,
  store: { browserType: BrowserType; userDataDir: string; profileDirectory?: string },
  timeoutMs = 20_000,
): Promise<BrowserDiscovery> {
  const pid = child.pid!;
  let exitError: Error | undefined;
  void exited.then((error) => {
    exitError = error;
  });
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (exitError) {
      const app = browserDisplayName(store.browserType);
      throw new Error(
        `${exitError.message}\n${app} (pid ${pid}) never served the DevTools protocol on port ${port} ` +
          `for profile "${profileName}". A ${app} already open on ${store.userDataDir} takes a new launch ` +
          `as an argument hand-off and never binds the port; quit it, then relaunch it with remote debugging:\n` +
          `  ${storeRelaunchCommand(store.browserType, port, store.userDataDir, store.profileDirectory)}\n` +
          `and retry. If none is open, the browser crashed on start.`,
      );
    }
    try {
      return await discoverBrowserWsUrl(port, 'localhost', profileName);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `Browser for profile "${profileName}" (pid ${pid}) did not serve the DevTools protocol on ` +
      `port ${port} within ${Math.round(timeoutMs / 1000)}s: ${lastError}`,
  );
}

const LAUNCH_STDERR_LINES = 5;

function browserDisplayName(browserType: BrowserType): string {
  return browserType.charAt(0).toUpperCase() + browserType.slice(1);
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps a just-spawned browser's early stderr so a death before CDP answers is reported in its
 * own words. `exited` settles once the process exits and stderr drains or 500 ms pass.
 */
function watchLaunchExit(child: ChildProcess, browserType: BrowserType): { exited: Promise<Error>; stopCapture: () => void } {
  let head = '';
  const capture = (chunk: Buffer) => {
    if (head.length < 16_384) head += chunk.toString();
  };
  child.stderr?.on('data', capture);
  const exited = new Promise<Error>((resolve) => {
    child.once('exit', (code, signal) => {
      const status = code !== null ? `code ${code}` : `signal ${signal}`;
      const stderr = child.stderr;
      const drained = new Promise<void>((done) => {
        if (!stderr || stderr.readableEnded || stderr.destroyed) return done();
        stderr.once('end', done);
        stderr.once('close', done);
      });
      void Promise.race([drained, delay(500)]).then(() => {
        const lines = head.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, LAUNCH_STDERR_LINES);
        const reason = lines.length > 0 ? `: ${lines.join('\n  ')}` : '';
        resolve(new Error(`${browserDisplayName(browserType)} exited during launch (${status})${reason}`));
      });
    });
  });
  return { exited, stopCapture: () => child.stderr?.off('data', capture).resume() };
}

export function killChrome(pid: number): void {
  if (process.platform === 'win32') {
    // On Windows process.kill is TerminateProcess, which skips Chromium's profile flush. Ask
    // taskkill for a graceful stop (no /F posts WM_CLOSE) and force-kill the tree only if that
    // fails or the process remains.
    try {
      execFileSync('taskkill', ['/pid', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } catch {
        // Process already dead
      }
    }
    return;
  }
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    // Process already dead
  }
}

export function getRunningChromeInfo(
  profileName: string
): { pid: number; port: number } | null {
  // Delegate to runtime-state, which auto-cleans stale files and verifies
  // the live pid still runs the command we recorded — so a recycled pid
  // doesn't masquerade as our browser.
  const rt = readProfileRuntime(profileName);
  if (!rt) return null;
  if (rt.port === undefined) return null;
  return { pid: rt.pid, port: rt.port };
}

/** Pre-launch `Default/Preferences`: names a new profile and, with `persistSessionCookies`, pins
 * `session.restore_on_startup: 1`, without which Chromium purges session-only login cookies.
 * Call only while the browser is down, or Chromium overwrites it on exit; a malformed file is left. */
export function ensureProfilePreferences(
  userDataDir: string,
  profileName: string,
  persistSessionCookies: boolean
): void {
  const defaultDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');

  let prefs: Record<string, any> | undefined;
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (typeof prefs !== 'object' || prefs === null) return; // not ours to fix
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return; // unreadable/malformed: leave alone
  }

  const firstLaunch = prefs === undefined;
  if (firstLaunch) prefs = { profile: { name: profileName } };

  let dirty = firstLaunch;
  if (persistSessionCookies && prefs!.session?.restore_on_startup !== 1) {
    prefs!.session = { ...prefs!.session, restore_on_startup: 1 };
    dirty = true;
  }
  if (!dirty) return;

  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch { /* not critical */ }
}

/**
 * Whether a TCP port is bound (`lsof`, or `netstat -ano` on Windows); false on tool error.
 * The one cross-platform probe: shelling out to lsof directly scans every port free on Windows.
 */
export function isPortInUse(port: number): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      // Lines look like: "  TCP    0.0.0.0:9200    0.0.0.0:0    LISTENING    1234"
      return out.split('\n').some((line) => {
        const f = line.trim().split(/\s+/);
        return f[0] === 'TCP' && f[3] === 'LISTENING' && !!f[1]?.endsWith(`:${port}`);
      });
    } catch {
      return false;
    }
  }
  try {
    execFileSync('lsof', ['-i', `:${port}`], { stdio: 'ignore' });
    return true; // lsof found a binding
  } catch {
    return false; // nothing on the port
  }
}

export function allocatePort(): number {
  const base = 9200;
  const max = 9300;

  for (let port = base; port < max; port++) {
    if (!isPortInUse(port)) {
      return port;
    }
  }

  throw new Error('No available ports in range 9200-9300');
}

/**
 * The `--user-data-dir` a running browser was launched with, or null. The attach-only guard uses
 * it to tell the owner's browser from a foreign process serving CDP on the same port.
 */
export function getProcessUserDataDir(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  let cmdline = '';
  try {
    if (process.platform === 'win32') {
      cmdline = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } else {
      cmdline = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
  } catch {
    return null;
  }
  return parseUserDataDirFromCommandLine(cmdline);
}

/**
 * The `--user-data-dir` value in either `=` or space form, ending at the next ` --<flag>` so a
 * path with spaces survives.
 */
export function parseUserDataDirFromCommandLine(cmdline: string): string | null {
  const line = cmdline.replace(/\r?\n/g, ' ').trim();
  const m = line.match(/--user-data-dir[=\s]+(.*?)(?=\s--[A-Za-z]|$)/);
  if (!m) return null;
  const value = m[1].trim().replace(/^["']|["']$/g, '');
  return value.length > 0 ? value : null;
}

export interface PortOccupant {
  pid: number;
  command: string;
}

/**
 * The process listening on a TCP port, or null; names a non-debug process holding a profile's port.
 */
export function getPortOccupant(port: number): PortOccupant | null {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let pid = 0;
      for (const line of out.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f[0] === 'TCP' && f[3] === 'LISTENING' && f[1]?.endsWith(`:${port}`)) {
          pid = parseInt(f[4], 10) || 0;
          break;
        }
      }
      if (!pid) return null;
      let command = 'unknown';
      try {
        // tasklist CSV row: "image.exe","1234","Console","1","12,345 K"
        const tl = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const m = tl.match(/^"([^"]+)"/);
        if (m) command = m[1];
      } catch { /* keep 'unknown' */ }
      return { pid, command };
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid = 0;
    let command = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = parseInt(line.slice(1), 10) || 0;
      else if (line.startsWith('c') && !command) command = line.slice(1);
    }
    if (!pid) return null;
    return { pid, command: command || 'unknown' };
  } catch {
    return null;
  }
}
