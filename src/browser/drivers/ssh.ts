import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as net from 'net';
import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { getPortOccupant } from '../chrome.js';
import { parseEndpointUrl } from '../profiles.js';
import { writeProfileRuntime, clearProfileRuntime } from '../runtime-state.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';
// shellQuote lives in the shared ssh-exec helper (single choke point); re-export
// so existing importers of `shellQuote` from this module keep working.
import { shellQuote, assertValidSshTarget, controlOpts, sshConnectOpts } from '../../runtime/ssh.js';
export { shellQuote };
// The `ssh -L` tunnel spawn is shared with `agents computer --device`; it lives in
// the single ssh-tunnel helper. Calling it with no options preserves this
// driver's original foreground, stderr-captured behavior exactly.
import { startSSHTunnel } from '../../runtime/ssh-tunnel.js';
import { encodePwshBase64 } from '../../runtime/pwsh.js';

export interface SSHConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  cleanup: () => void;
}

/**
 * Shell dialect of the remote host, from `&os=windows` on an `ssh://` target.
 * Windows OpenSSH defaults to cmd.exe: no `&` backgrounding, no `lsof`, `.exe`.
 */
export type RemoteOs = 'windows' | 'posix';

export interface SSHConnectOptions {
  /**
   * Attach to a browser another device declared: never launch a fresh remote
   * chrome-data or kill it on tunnel close, since it holds the caller's logins.
   */
  persistRemote?: boolean;
}

/** Lifecycle for a registry-driven tunnel vs a profile the daemon launched. */
export function persistRemoteLifecycle(persistRemote: boolean): {
  launchRemote: boolean;
  killOnCleanup: boolean;
} {
  return persistRemote
    ? { launchRemote: false, killOnCleanup: false }
    : { launchRemote: true, killOnCleanup: true };
}

export async function connectSSH(
  endpoint: string,
  profile: BrowserProfile,
  /**
   * Runtime key (`<profile>@<device>`) the tunnel's record is stored under;
   * `profile.name` is the bare user-facing name, used only in messages.
   */
  key: ConnectionKey,
  opts: SSHConnectOptions = {},
): Promise<SSHConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'ssh:') {
    throw new Error(`Invalid SSH endpoint: ${endpoint}`);
  }

  const user = url.username || process.env.USER || 'root';
  // Use the shared parser so the documented `ssh://host?port=N` form works
  // identically to `ssh://host:N`. Previously `url.port` alone meant every
  // `?port=`-style profile silently fell back to 9222.
  const parsed = parseEndpointUrl(endpoint);
  if (!parsed) {
    throw new Error(`Could not extract host:port from SSH endpoint: ${endpoint}`);
  }
  const host = parsed.host;
  const remotePort = parsed.port;

  // `&os=windows` switches the remote-command dialect (cmd.exe launch via
  // `start`, taskkill teardown). Anything else — including absent — is posix.
  // The query param is the single source of truth so the driver never has to
  // be threaded a separate per-profile field.
  const remoteOs: RemoteOs =
    (url.searchParams.get('os') || '').toLowerCase() === 'windows' ? 'windows' : 'posix';

  // Bind the tunnel to the SAME local port the user configured. Using an
  // allocated port instead made `status` print confusing rows like
  // `port 9200 (configured 10005)` and made it impossible to predict which
  // local port a profile would land on. Now `ssh://host?port=N` => local N.
  const localPort = remotePort;

  // Preflight: if the local port is busy with something that isn't our
  // own SSH tunnel for this very target, bail with a clear error. Letting
  // ssh -L race ahead would either silently succeed (binding to a second
  // port via fail-safe) or fail with cryptic stderr.
  const occupant = getPortOccupant(localPort);
  if (occupant && !isOwnTunnel(occupant.pid, host, remotePort)) {
    throw new Error(
      `Local port ${localPort} (needed for SSH tunnel to ${host}:${remotePort}) ` +
        `is already in use by ${occupant.command} (pid ${occupant.pid}). ` +
        `Either kill that process (\`kill ${occupant.pid}\`) or change the profile's port.`
    );
  }

  // A non-zero remote exit rejects with stderr; an already-running browser
  // exits 0, so only genuine launch failures reach the caller. persistRemote
  // skips the launch, which would mint a logged-out user-data-dir under a name
  // that means a credentialed browser on the declaring device.
  const lifecycle = persistRemoteLifecycle(Boolean(opts.persistRemote));
  if (lifecycle.launchRemote) {
    await ensureRemoteBrowser(user, host, profile.browser, remotePort, remoteOs, profile.binary);
  }

  let tunnel: ChildProcess;
  if (occupant) {
    // Reuse the existing tunnel rather than spawning a duplicate.
    tunnel = { pid: occupant.pid, kill: () => { try { process.kill(occupant.pid); } catch { /* gone */ } } } as ChildProcess;
  } else {
    tunnel = await startSSHTunnel(user, host, localPort, remotePort);
  }

  try {
    await waitForPort(localPort, 8000);
  } catch {
    tunnel.kill();
    throw new Error(`SSH tunnel failed to establish to ${host}`);
  }

  let wsUrl: string;
  let browser: string;
  try {
    ({ wsUrl, browser } = await discoverBrowserWsUrl(localPort, 'localhost', profile.name));
  } catch (err) {
    tunnel.kill();
    if (opts.persistRemote) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Browser profile "${profile.name}" is declared on ${host}, but nothing is speaking CDP on port ${remotePort}: ${why}`,
      );
    }
    throw err;
  }
  try {
    verifyBrowserIdentity(browser, profile.browser, remotePort, host);
  } catch (err) {
    tunnel.kill();
    throw err;
  }
  const cdp = new CDPClient();
  await cdp.connect(wsUrl);

  // Record the tunnel in the profile's runtime so a future daemon — or
  // the orphan reaper after a crash — can find and clean it up. The
  // `kind: 'tunnel'` flag distinguishes it from a locally-launched
  // browser process.
  const tunnelPid = tunnel.pid ?? 0;
  if (tunnelPid > 0) {
    writeProfileRuntime(key, {
      pid: 0,
      port: localPort,
      command: 'ssh',
      kind: 'tunnel',
      tunnelPid,
    });
  }

  return {
    cdp,
    port: localPort,
    pid: tunnelPid,
    cleanup: () => {
      cdp.close();
      // Kill the remote browser BEFORE tearing down the tunnel — but only
      // when we launched it. persistRemote is an attach to someone else's
      // declared browser; killing it would drop the logins the caller came
      // for. Fire-and-forget — cleanup stays synchronous.
      if (lifecycle.killOnCleanup) {
        killRemoteBrowser(user, host, remoteOs, remotePort).catch(() => {});
      }
      tunnel.kill();
      clearProfileRuntime(key);
    },
  };
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await tryConnect(port);
      return;
    } catch {
      await sleep(200);
    }
  }

  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

function tryConnect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', reject);
  });
}

// macOS .app launchers — the historical POSIX table.
const POSIX_BROWSER_PATHS: Record<string, string> = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  comet: '/Applications/Comet.app/Contents/MacOS/Comet',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  arc: '/Applications/Arc.app/Contents/MacOS/Arc',
};

// Windows App Paths keys per browser. CreateProcess ignores App Paths (unlike
// ShellExecute/`start`), so the launch script resolves the real `.exe` from
// this key, covering Program Files and Program Files (x86).
const WIN_BROWSER_APPPATH: Record<string, string> = {
  chrome: 'chrome.exe',
  chromium: 'chrome.exe',
  brave: 'brave.exe',
  edge: 'msedge.exe',
};

/** Single-quote a string for embedding inside a PowerShell literal. */
function psSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Wrap a PowerShell script as `-EncodedCommand`: base64 of UTF-16LE is one
 * quote-free token that survives spawn → sshd → cmd.exe without escaping.
 */
export function encodePowerShell(script: string): string {
  return `powershell -NoProfile -EncodedCommand ${encodePwshBase64(script)}`;
}

/** Launch via a one-shot task the logged-on user registers, starts and unregisters, so it runs in
 * the interactive session: sshd reaps the job tree on disconnect, and WMI lands in session 0
 * where DevTools never starts. A distinct --user-data-dir binds the port beside an open Edge. */
export function buildWindowsLaunchScript(
  browserType: string,
  port: number,
  customBinary?: string
): string {
  let exeStmts: string[];
  if (customBinary) {
    exeStmts = [`$exe = ${psSingleQuote(customBinary)}`];
  } else if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  } else {
    const exeKey = WIN_BROWSER_APPPATH[browserType];
    if (!exeKey) throw new Error(`Unknown browser type for windows remote: ${browserType}`);
    const appPath = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeKey}`;
    // Per-user installs (the default for Edge and Chrome) register under HKCU,
    // so try HKLM then HKCU. PowerShell 5.1 has no `??`; a missing exe throws so
    // it surfaces as a non-zero ssh exit instead of a silent empty launch.
    exeStmts = [
      `$exe = (Get-ItemProperty 'HKLM:\\${appPath}' -EA SilentlyContinue).'(default)'`,
      `if (-not $exe) { $exe = (Get-ItemProperty 'HKCU:\\${appPath}' -EA SilentlyContinue).'(default)' }`,
      `if (-not $exe) { throw 'browser exe not found in HKLM/HKCU App Paths: ${exeKey}' }`,
    ];
  }
  // Keep the `--remote-allow-origins=http://127.0.0.1:${port}` literal in
  // source — a test asserts CDP is never opened to `*`.
  return [
    ...exeStmts,
    // First-run modals block automation, and `browser stop` hard-kills the
    // remote, so the next launch on the same user-data-dir would restore a
    // "crashed" session and swap the page target mid-command.
    `$args = '--remote-debugging-port=${port}` +
      ` --remote-allow-origins=http://127.0.0.1:${port}` +
      ` --no-first-run --no-default-browser-check` +
      ` --hide-crash-restore-bubble --disable-session-crashed-bubble` +
      ` --disable-background-timer-throttling --user-data-dir="' + $env:TEMP + '\\agents-browser-${port}"'`,
    `$action = New-ScheduledTaskAction -Execute $exe -Argument $args`,
    `Register-ScheduledTask -TaskName 'agents-browser-${port}' -Action $action -Force | Out-Null`,
    `Start-ScheduledTask -TaskName 'agents-browser-${port}'`,
    `Unregister-ScheduledTask -TaskName 'agents-browser-${port}' -Confirm:$false`,
  ].join('; ');
}

/**
 * Tree-kill (`taskkill /T`) the CDP port's owner: orphaned children keep
 * SingletonLock, so later launches on that `--user-data-dir` never bind the port.
 */
export function buildWindowsKillScript(port: number): string {
  return (
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
    `| ForEach-Object { taskkill /PID $_.OwningProcess /T /F 2>$null } | Out-Null`
  );
}

/**
 * Remote command that launches the browser detached with a CDP port: POSIX
 * backgrounds the binary with `&`, Windows uses the scheduled-task script.
 */
export function buildLaunchCmd(
  remoteOs: RemoteOs,
  browserType: string,
  port: number,
  customBinary?: string
): string {
  if (remoteOs === 'windows') {
    return encodePowerShell(buildWindowsLaunchScript(browserType, port, customBinary));
  }
  const browserPath = customBinary ?? POSIX_BROWSER_PATHS[browserType];
  if (!browserPath) {
    if (browserType === 'custom') {
      throw new Error('browser: custom requires a binary path in the profile');
    }
    throw new Error(`Unknown browser type for posix remote: ${browserType}`);
  }
  return [
    shellQuote(browserPath),
    `--remote-debugging-port=${port}`,
    shellQuote(`--remote-allow-origins=http://127.0.0.1:${port}`),
    '--disable-background-timer-throttling',
    `--user-data-dir=/tmp/agents-browser-${port}`,
    '</dev/null >/dev/null 2>&1 &',
  ].join(' ');
}

/** Remote command that kills whatever holds the CDP port (POSIX `lsof`+`kill`, Windows PowerShell). */
export function buildKillCmd(remoteOs: RemoteOs, port: number): string {
  if (remoteOs === 'windows') {
    return encodePowerShell(buildWindowsKillScript(port));
  }
  return `pids=$(lsof -ti ${shellQuote(`:${port}`)} 2>/dev/null); [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true`;
}

export async function ensureRemoteBrowser(
  user: string,
  host: string,
  browserType: string,
  port: number,
  remoteOs: RemoteOs,
  customBinary?: string
): Promise<void> {
  // `user`/`host` come from a git-tracked ssh:// endpoint. Validate before the
  // raw `ssh` spawn: `ssh://-Fattack@victim` would parse as `-F <file>`, and a
  // hostile ssh config's ProxyCommand would run locally.
  assertValidSshTarget(`${user}@${host}`);
  const remoteCmd = buildLaunchCmd(remoteOs, browserType, port, customBinary);

  return new Promise((resolve, reject) => {
    // Capture stderr so a launch failure surfaces here, not later as a tunnel
    // timeout. Options go before the target: macOS's BSD getopt stops at the
    // first non-option, so a later `-o` would become part of the remote command.
    const child = spawn(
      'ssh',
      [
        ...sshConnectOpts(controlOpts()),
        `${user}@${host}`,
        remoteCmd,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    );

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // ssh is still running the backgrounding launch command past our window.
      // Killing the local ssh client does NOT reap the WMI/detached remote
      // browser, so treat this as launched and let waitForPort confirm.
      child.kill();
      resolve();
    }, 2000);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code && code !== 0) {
        const detail = stderr.trim();
        reject(
          new Error(
            `Remote browser launch failed on ${host} (ssh exit ${code})` +
              (detail ? `: ${detail}` : '')
          )
        );
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Kill the remote browser holding the CDP port on stop/cleanup, so it is not
 * orphaned when the tunnel closes. Best-effort: never rejects.
 */
export function killRemoteBrowser(
  user: string,
  host: string,
  remoteOs: RemoteOs,
  port: number
): Promise<void> {
  return runSSHCommand(user, host, buildKillCmd(remoteOs, port));
}

function runSSHCommand(user: string, host: string, cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Reject an option-injecting target (e.g. a `-`-leading user from a crafted
    // ssh:// profile) before it reaches the raw `ssh` spawn. Reject rather than
    // throw synchronously so `killRemoteBrowser(...).catch()` stays best-effort.
    // See ensureRemoteBrowser.
    try {
      assertValidSshTarget(`${user}@${host}`);
    } catch (err) {
      reject(err as Error);
      return;
    }
    // Reuse the shared hardened baseline so a hung TCP SYN to an unreachable
    // host is bounded by ConnectTimeout (the local 3s kill below only bounds a
    // connected-but-slow command, not the connect itself). Options precede the
    // target — see ensureRemoteBrowser.
    const child = spawn('ssh', [...sshConnectOpts(controlOpts()), `${user}@${host}`, cmd], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
    setTimeout(() => {
      child.kill();
      resolve();
    }, 3000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the pid on our local port is our ssh tunnel to `host:remotePort`.
 * POSIX matches `ps` args; Windows only has tasklist's image name.
 */
export function isOwnTunnel(pid: number, host: string, remotePort: number): boolean {
  if (process.platform === 'win32') {
    const occupant = getPortOccupant(remotePort);
    if (!occupant || occupant.pid !== pid) return false;
    return occupant.command.toLowerCase().startsWith('ssh');
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (!out.startsWith('ssh')) return false;
    if (!out.includes(host)) return false;
    if (!out.includes(`:${remotePort}`) && !out.includes(`:127.0.0.1:${remotePort}`)) return false;
    return true;
  } catch {
    return false;
  }
}
