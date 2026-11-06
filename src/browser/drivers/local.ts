import * as net from 'net';

import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { launchBrowser, getPortOccupant, getProcessUserDataDir, storeOccupant, storeRelaunchCommand } from '../chrome.js';
import { parseEndpointUrl, isAttachOnlyProfile, resolveProfileDataDir, normalizeDataDir } from '../profiles.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

/**
 * TCP "is something bound here?" probe for when lsof misses the holder (Comet
 * and other Electron apps hold sockets `-sTCP:LISTEN` does not report).
 */
async function probeTcpBound(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const cleanup = () => {
      sock.removeAllListeners();
      sock.destroy();
    };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); cleanup(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); cleanup(); resolve(false); });
  });
}

export interface LocalConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
}

/**
 * Local listeners we refuse to attach through: they forward CDP to another host,
 * so a `cdp://127.0.0.1:N` profile would silently drive a remote browser.
 */
const TUNNEL_PROCESS_NAMES = new Set(['ssh', 'autossh', 'mosh-client', 'socat']);

function isTunnelProcess(command: string): boolean {
  return TUNNEL_PROCESS_NAMES.has(command.toLowerCase());
}

/**
 * Arc is single-instance: a relaunch with a fresh `--user-data-dir` goes to the
 * running, non-debuggable Arc. So we only attach, and fail with the relaunch.
 */
export function arcAttachRequiredError(profileName: string, port: number): Error {
  return new Error(
    `Arc is not exposing a CDP endpoint on cdp://127.0.0.1:${port} for profile ` +
      `"${profileName}". Arc is single-instance — browser attaches to your ` +
      `RUNNING Arc and never launches a second one, so it will not start an isolated ` +
      `Arc for you. Quit Arc, then relaunch it with remote debugging on this port:\n` +
      `  open -a Arc --args --remote-debugging-port=${port}\n` +
      `and retry. The port must match the profile's endpoint (\`browser profiles list\`).`
  );
}

/**
 * Error for an attach-only profile with nothing debuggable on its port: never
 * spawn a rival window; name the relaunch pinned to the durable `--user-data-dir`.
 */
export function attachOnlyRequiredError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir'>,
  port: number
): Error {
  if (profile.browser === 'arc') return arcAttachRequiredError(profile.name, port);
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  const dataDir = resolveProfileDataDir(profile);
  return new Error(
    `Profile "${profile.name}" is attach-only and nothing is serving the Chrome ` +
      `DevTools Protocol on cdp://127.0.0.1:${port}. browser attaches to the ` +
      `${app} you already started and never launches a second one, so it will not spawn ` +
      `a rival window (that is the duplicate, logged-out tile this profile exists to ` +
      `prevent). Launch the canonical ${app} with remote debugging on its durable data dir:\n` +
      `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${dataDir}\n` +
      `and retry. Keep signing in once in that window — the data dir is durable, so the ` +
      `login survives quit+relaunch.`
  );
}

/**
 * Error for a foreign browser serving CDP on an attach-only profile's port (its
 * `--user-data-dir` is not the profile's): a port-squatter passes the family check.
 */
export function foreignInstanceError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir'>,
  port: number,
  runningDataDir: string,
  pid: number
): Error {
  const expected = resolveProfileDataDir(profile);
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  return new Error(
    `Attach-only ownership check failed for profile "${profile.name}" on ` +
      `cdp://127.0.0.1:${port}: a ${app} is serving CDP there (pid ${pid}) but it is ` +
      `running a FOREIGN user-data-dir\n` +
      `  running:  ${runningDataDir}\n` +
      `  expected: ${expected}\n` +
      `so it is not this profile's credentialed browser. browser will not drive it. Close ` +
      `that instance (\`kill ${pid}\`), then relaunch the canonical ${app}:\n` +
      `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${expected}`
  );
}

/**
 * Error for a store already held by a browser without a debug port: Chromium
 * would hand the launch to that instance and exit, so the port never binds.
 */
export function storeInUseError(
  profile: Pick<BrowserProfile, 'name' | 'browser' | 'userDataDir' | 'profileDirectory'>,
  port: number,
  pid: number,
): Error {
  const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
  const dataDir = resolveProfileDataDir(profile);
  return new Error(
    `Profile "${profile.name}" is pinned to ${dataDir}, and a ${app} (pid ${pid}) already has that ` +
      `store open without remote debugging, so nothing serves the Chrome DevTools Protocol on ` +
      `cdp://127.0.0.1:${port}. browser will not launch a second ${app} on the same store. ` +
      `Quit that ${app}, then relaunch it with remote debugging:\n` +
      `  ${storeRelaunchCommand(profile.browser, port, dataDir, profile.profileDirectory)}\n` +
      `and retry. Your logins stay: the store is the one you already use.`,
  );
}

/**
 * Prefix every ownership-rejection message carries, so `connectLocal`'s catch can
 * re-throw it verbatim instead of misreading it as "attach failed, launch fresh".
 */
const OWNERSHIP_REJECTION_PREFIX = 'Attach-only ownership check failed';

/**
 * Verify the CDP occupant's live `--user-data-dir` matches this attach-only
 * profile's durable dir. An unreadable occupant fails closed: it is the squat case.
 */
function verifyEndpointOwnership(profile: BrowserProfile, port: number): void {
  // Attach-only profiles and profiles pinned to the owner's own store
  // both name the exact user-data dir a running instance must have.
  if (!isAttachOnlyProfile(profile) && !profile.userDataDir) return;
  // Arc is the user's single running instance under its own default data dir; it
  // has no managed durable dir to compare against and no /tmp-squat vector.
  if (profile.browser === 'arc') return;
  const occupant = getPortOccupant(port);
  if (!occupant) return;
  const expected = resolveProfileDataDir(profile);
  const runningDataDir = getProcessUserDataDir(occupant.pid);
  if (!runningDataDir) {
    throw new Error(
      `${OWNERSHIP_REJECTION_PREFIX} for profile "${profile.name}" on cdp://127.0.0.1:${port}: ` +
        `a process (pid ${occupant.pid}) is serving CDP there but its --user-data-dir could not be ` +
        `read, so ownership can't be confirmed. Refusing to attach to an unverified instance. If ` +
        `this is your canonical browser, relaunch it with --user-data-dir=${expected} so the ` +
        `attach-only guard can verify it.`,
    );
  }
  if (normalizeDataDir(runningDataDir) !== normalizeDataDir(expected)) {
    throw foreignInstanceError(profile, port, runningDataDir, occupant.pid);
  }
}

export async function connectLocal(
  endpoint: string,
  profile: BrowserProfile,
  /**
   * Runtime key (`<profile>@<endpoint>`) for the user-data-dir, pid and port
   * files; `profile.name` stays the bare user-facing name.
   */
  key: ConnectionKey,
): Promise<LocalConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'cdp:') {
    throw new Error(`Invalid local endpoint: ${endpoint}`);
  }

  // Share the parser with the SSH driver and the collision-detection code
  // path so `cdp://host:N` and `cdp://host?port=N` behave identically.
  const parsed = parseEndpointUrl(endpoint);
  const port = parsed?.port ?? 9222;

  // Refuse an SSH tunnel before speaking CDP: `verifyBrowserIdentity` cannot
  // tell a local browser from the far end of `ssh -L`, and a stale tunnel would
  // silently hijack any local profile on the same port.
  const preOccupant = getPortOccupant(port);
  if (preOccupant && isTunnelProcess(preOccupant.command)) {
    throw new Error(
      `Port ${port} is held by ${preOccupant.command} (pid ${preOccupant.pid}), an SSH ` +
        `tunnel forwarding to a remote host. Profile "${profile.name}" is configured as ` +
        `local (${endpoint}) but traffic would round-trip to another machine. Either kill ` +
        `the tunnel (\`kill ${preOccupant.pid}\`) and retry, or switch the profile to an ` +
        `ssh:// endpoint to drive the remote browser explicitly.`
    );
  }

  try {
    const { wsUrl, browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
    verifyBrowserIdentity(browser, profile.browser, port);
    // Ownership beyond browser FAMILY: a foreign /tmp Comet answers
    // CDP on the canonical port and passes verifyBrowserIdentity, so before we
    // adopt the endpoint confirm its --user-data-dir is this profile's durable
    // dir. Rejects the port-squatter loudly instead of driving it.
    verifyEndpointOwnership(profile, port);
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port, pid: 0 };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
      throw err;
    }
    // An ownership rejection is a definitive answer — never fall through to a
    // fresh launch or a generic port message. Re-throw it verbatim.
    if (err instanceof Error && err.message.startsWith(OWNERSHIP_REJECTION_PREFIX)) {
      throw err;
    }

    // The attach failed: nothing debuggable is on this port. Never fall through
    // to launchBrowser, which would spawn a duplicate window; fail with the relaunch.
    if (isAttachOnlyProfile(profile)) {
      throw attachOnlyRequiredError(profile, port);
    }

    // Distinguish "nothing listening on this port" (fine to launch fresh) from
    // "something is listening but it's not a debuggable browser" (bail loudly —
    // silently launching on a different port leads to confusing `pid 0` and
    // `CDP connection not open` errors downstream).
    const occupant = getPortOccupant(port);
    if (occupant) {
      throw new Error(
        `Port ${port} is occupied by ${occupant.command} (pid ${occupant.pid}) but is ` +
          `not serving the Chrome DevTools Protocol. Either stop that process ` +
          `(\`kill ${occupant.pid}\`) or restart it with \`--remote-debugging-port=${port}\` ` +
          `so profile "${profile.name}" can attach.`
      );
    }

    // lsof-based detection misses some Electron-family processes (Comet, custom
    // chrome wrappers). Cheap TCP probe as a safety net: if something ACKs a
    // connect, the port is bound — bail loudly with the profile name + endpoint
    // rather than silently launching a duplicate browser.
    if (await probeTcpBound(port)) {
      throw new Error(
        `Profile "${profile.name}" is configured for cdp://127.0.0.1:${port}, ` +
          `but something is already bound to that port without serving the Chrome ` +
          `DevTools Protocol. If that's your browser running without remote debugging, ` +
          `quit it and relaunch with \`--remote-debugging-port=${port}\`. Otherwise, ` +
          `update the profile to a free port (\`browser profiles list\`).`
      );
    }

    // A store-pinned profile launches on the owner's store only while nothing
    // holds it; a browser already open there without a port must be relaunched
    // by the owner, never doubled.
    if (profile.userDataDir) {
      const holder = storeOccupant(profile.userDataDir);
      if (holder) throw storeInUseError(profile, port, holder.pid);
    }

    const newPort = port;
    const chromeOpts = {
      ...profile.chrome,
      viewport: profile.viewport,
      // A discovered native profile launches the owner's browser on its own
      // store: one window for the owner and agents, logins intact.
      ...(profile.userDataDir
        ? { userDataDir: profile.userDataDir, profileDirectory: profile.profileDirectory }
        : {}),
    };
    let launched;
    try {
      launched = await launchBrowser(
        key,
        profile.browser,
        newPort,
        chromeOpts,
        profile.secrets,
        profile.binary,
        profile.electron === true
      );
    } catch (launchErr) {
      const reason = (launchErr instanceof Error ? launchErr.message : String(launchErr)).replace(/\.$/, '');
      throw new Error(
        `Could not start ${profile.browser} for profile "${profile.name}" on port ${newPort}: ${reason}. ` +
          `Check that the browser binary is installed (\`browser profiles list\`) and ` +
          `that no other process is holding the port.`
      );
    }
    return { cdp: launched.cdp, port: newPort, pid: launched.pid };
  }
}
