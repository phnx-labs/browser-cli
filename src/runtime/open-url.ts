import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfigValue } from './device-config.js';
import { encodePwshBase64 } from './pwsh.js';

export type ShowOutcome =
  | { via: 'profile'; profile: string; tabId?: string; reused: boolean }
  /** `fellBackFrom`/`reason`: a viewer was configured but could not be used, and nothing was shown there. */
  | { via: 'open'; fellBackFrom?: string; reason?: string }
  | { via: 'none'; profile?: string; reason?: string };

interface ShowOptions {
  osBrowser?: boolean;
  profile?: string;
  fresh?: boolean;
}

const BROWSER_RENDERABLE = new Set(['.html', '.htm', '.svg', '.xhtml']);

/** xdg-open's generic mode runs the browser in the foreground, so a handler still running is the viewer. */
const OPENER_SETTLE_MS = 10_000;

/** A spawn alone proves nothing: xdg-open with no display spawns, then exits 3. */
function osOpen(target: string): Promise<{ via: 'open' } | { via: 'none'; reason: string }> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return Promise.resolve({ via: 'none', reason: 'this machine has no display (DISPLAY and WAYLAND_DISPLAY are unset)' });
  }
  // explorer.exe exits 1 after opening; Start-Process fails loudly when nothing handles the target.
  const [opener, args] = process.platform === 'darwin'
    ? ['open', [target]]
    : process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePwshBase64(`$ErrorActionPreference='Stop'; Start-Process -FilePath '${target.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`)]]
      : ['xdg-open', [target]];
  // A file, not a pipe: the browser the handler starts inherits stderr and must never write into a closed pipe.
  const errDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-show-'));
  const errFd = fs.openSync(path.join(errDir, 'stderr'), 'w+');
  const lastErrorLine = () => fs.readFileSync(path.join(errDir, 'stderr'), 'utf8').trim().split('\n').pop() ?? '';
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fs.closeSync(errFd);
    try { fs.rmSync(errDir, { recursive: true, force: true, maxRetries: 3 }); } catch { return; }
  };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opener, args, { stdio: ['ignore', 'ignore', errFd], detached: true, windowsHide: true });
    } catch (err) {
      release();
      resolve({ via: 'none', reason: `${opener}: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    const settled = setTimeout(() => { child.unref(); release(); resolve({ via: 'open' }); }, OPENER_SETTLE_MS);
    child.once('error', (err) => { clearTimeout(settled); release(); resolve({ via: 'none', reason: `${opener}: ${err.message}` }); });
    child.once('exit', (code, signal) => {
      clearTimeout(settled);
      if (released) return;
      const said = lastErrorLine();
      release();
      child.unref();
      if (code === 0) resolve({ via: 'open' });
      else resolve({ via: 'none', reason: `${opener} exited ${code ?? signal}${said ? `: ${said}` : ''}` });
    });
  });
}

async function fallBack(target: string, from: string, reason: string): Promise<ShowOutcome> {
  console.error(`[viewer] ${from}: ${reason} — using the OS browser.`);
  const opened = await osOpen(target);
  return opened.via === 'open' ? { via: 'open', fellBackFrom: from, reason } : { via: 'none', profile: from, reason: `${reason}; ${opened.reason}` };
}

/** `--profile`, else `browser.viewer`, else `browser.profile`; `os`, or nothing, is the OS handler. */
async function resolveViewer(opts: ShowOptions): Promise<'os' | { profile: string } | { unusable: string; reason: string }> {
  if (opts.osBrowser) return 'os';
  const { getConfiguredDefaultProfileName, resolveProfileRef, getProfile } = await import('../browser/profiles.js');
  const name = opts.profile
    ?? ((getConfigValue('browser.viewer').value as string | undefined) || undefined)
    ?? getConfiguredDefaultProfileName();
  if (!name || name === 'os') return 'os';

  const resolved = await resolveProfileRef(name);
  const profile = resolved ? await getProfile(resolved) : null;
  if (!resolved || !profile) return { unusable: name, reason: 'not a configured profile' };
  if (profile.browser === 'firefox') return { unusable: resolved, reason: 'a headless-automation Firefox profile' };
  return { profile: resolved };
}

/** Falls back to the OS handler only when the viewer is unusable or the daemon unreachable,
 * never once the daemon has answered: it may already have opened or reloaded a tab. */
export async function showUrl(url: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  const viewer = await resolveViewer(opts);
  if (viewer === 'os') return osOpen(url);
  if ('unusable' in viewer) return fallBack(url, viewer.unusable, viewer.reason);

  const { sendIPCRequest, isBrowserServiceReachable } = await import('../browser/ipc.js');
  let response;
  try {
    response = await sendIPCRequest({ action: 'show', url, profile: viewer.profile, fresh: opts.fresh });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!(await isBrowserServiceReachable())) return fallBack(url, viewer.profile, `browser service unreachable: ${reason}`);
    return { via: 'none', profile: viewer.profile, reason };
  }
  if (!response.ok) return { via: 'none', profile: viewer.profile, reason: response.error };
  return { via: 'profile', profile: viewer.profile, tabId: response.tabId, reused: response.refreshed === true };
}

/** Browser-renderable files go through {@link showUrl}; a screenshot or recording goes to the OS app. */
export async function showFile(filePath: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  if (!BROWSER_RENDERABLE.has(path.extname(filePath).toLowerCase())) return osOpen(filePath);
  return showUrl(pathToFileURL(filePath).href, opts);
}
