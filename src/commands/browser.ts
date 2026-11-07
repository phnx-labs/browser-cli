import { Command, Option } from 'commander';
import chalk from 'chalk';
import { isatty } from 'node:tty';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  listProfiles,
  getProfile,
  createProfile,
  deleteProfile,
  getConfiguredDefaultProfileName,
  resolveProfileRef,
  resolveProfileRefForStart,
  getProfileRuntimeDir,
  extractConfiguredPort,
  findFreeProfilePort,
  getEndpointPresets,
  formatProfilesTable,
  type BrowserProfile,
  editProfile,
  renameProfile,
  assertRegistrableProfileName,
  isProfileLaunchableHere,
  isAttachOnlyProfile,
  resolveProfileDataDir,
  normalizeDataDir,
  persistDiscoveredProfile,
  type EditableProfileFields,
} from '../browser/profiles.js';
import { declaringDevices, migrateCentralBrowserProfiles, profileKind } from '../browser/registry.js';
import type { BrowserProfileConfig } from '../runtime/types.js';
import {
  profilesLoggedInto,
  serviceForUrl,
  loginsWithAccountsForProfile,
  credKeysForService,
  AUTH_SIGNATURES,
} from '../browser/login-detection.js';
import { parseSecretRef, secretSite } from '../browser/secret-ref.js';
import { readAndResolveBundleEnv, bundleExists, readBundle } from '../runtime/secrets.js';
import { findBrowserPath, getPortOccupant, getProcessUserDataDir, isLauncherScript, listInstalledBrowsers } from '../browser/chrome.js';
import {
  listProfileCacheDirs,
  removeProfileCache,
  listAllProfileSnapshots,
  buildProfilePrunePlan,
  pruneProfiles,
  PRUNE_REASON_TEXT,
  identityLoopbackMismatch,
} from '../browser/runtime-state.js';
import { DEFAULT_VIEWPORT, parseWindowSize, parseWindowPosition } from '../browser/devices.js';
import { runBrowserSessionsCommand } from './browser-sessions-picker.js';
import { discoverBrowserWsUrl, verifyBrowserIdentity } from '../browser/cdp.js';
import { parseTargetFilter } from '../browser/service.js';
import {
  BrowserServiceNotRunningError,
  formatBrowserServiceNotRunningError,
  sendIPCRequest as sendRawIPCRequest,
  stopBrowserService,
  type IPCRequestOptions,
} from '../browser/ipc.js';
import type { IPCRequest, IPCResponse, PageSnapshot } from '../browser/types.js';
import {
  bindTask,
  getTaskBinding,
  honorScreenshotOutput,
  isTerminalBrowserVerb,
  REJECT_DEVICE_MESSAGE,
  resolveTaskRoute,
  unbindTask,
  unbindTasksForProfile,
  updateTaskBinding,
  startForwardTarget,
} from '../browser/task-index.js';
import { callerIdentityEnv, resolveCallerIdentity } from '../browser/caller-identity.js';
import {
  buildRemoteBrowserCommand,
  captureOnHost,
  copyFromHost,
  copyToHost,
  forwardedCommandArgv,
  isSelfHost,
  resolveHost,
  streamOnHost,
} from '../runtime/remote.js';
import { relayExec, relayFetchFile, relayFromEnv } from '../runtime/relay.js';
import { browserTaskPicker, type BrowserTask } from './browser-picker.js';
import { assertRemoteControlAllowed, FLEET_REMOTE_ENV, isFleetRemoteInvocation } from '../browser/remote-control.js';
import { getConfigValue, setConfigValue, unsetConfigValue } from '../runtime/device-config.js';
import { isInteractiveTerminal, printLine } from '@phnx-labs/tui';
import { registerCommandGroups, setHelpSections } from '../runtime/help.js';
import { buildHar } from '../browser/har.js';
import { getCliVersion } from '../version.js';
import { runBrowserIPCStream } from '../browser/stream.js';
import { machineId } from '../runtime/machine-id.js';
import { shellQuote } from '../runtime/ssh.js';
import type { ShowOutcome } from '../runtime/open-url.js';
import { isArcRunning } from '../browser/drivers/arc.js';
import { resolveBrowserTarget } from '../browser/resolve-target.js';
import { resolveSiteGuide, type SiteGuide } from '../browser/site-guides.js';
import { BrowserSkillsUnavailableError } from '../runtime/skills.js';
import { registerSkillsCommand } from './skills.js';
import { registerHelpJsonCommand } from './help-json.js';
import { bindArgument, intOption, pointArgument, refArgument } from './args.js';
import { grepText } from '../browser/text-grep.js';

/** Unambiguous session task inferred by the page-verb hook when --task is omitted. */
let inferredTaskName: string | undefined;

/** Resolve explicit flag, environment default, then session index; otherwise defer to the daemon.
 * Reject page-verb --device. */
const SNAPSHOT_OPTION_FLAG = '--snapshot';
const SNAPSHOT_OPTION_DESC =
  'After the action settles, also print the page url, title and interactive refs (what `browser refs` would print next) — one round trip instead of two';

const NO_WAIT_OPTION_FLAG = '--no-wait';
const NO_WAIT_OPTION_DESC =
  'Return as the action lands instead of once the page has settled (a load and the requests that draw it, a router render, or nothing happening). Firefox and Arc always return as the action lands';
/** `--wait` was the opt-in before settling became the default; a skill copied before then still passes it. */
const waitOption = () => new Option('--wait').hideHelp();

/** A `type`/`select` target: a whole number is a ref from the latest listing, anything else names the element. */
function refOrName(target: string): { ref: number } | { name: string } {
  return /^\d+$/.test(target.trim()) ? { ref: Number(target) } : { name: target };
}

/** Read piped evaluate source only when requested; an open silent stdin may never end. */
function readStdinScript(): string {
  let script: string;
  try {
    script = fs.readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`Cannot read --file -: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!script.trim()) {
    console.error('--file - read nothing from stdin; pipe the script in, e.g. browser evaluate --file - <<\'JS\'');
    process.exit(1);
  }
  return script;
}

/** Print a `--snapshot` result under an action's own result line. */
function printSnapshot(snapshot: PageSnapshot | undefined): void {
  if (!snapshot) return;
  const where = snapshot.title ? `${snapshot.title} — ${snapshot.url}` : snapshot.url;
  console.log(`\n${where}`);
  console.log(snapshot.refs || '(no interactive elements)');
}

function resolveTaskName(opts: { task?: string; device?: string }): string | undefined {
  if (opts.device) {
    const route = resolveTaskRoute({ device: opts.device });
    console.error(route.kind === 'reject-device' ? route.message : REJECT_DEVICE_MESSAGE);
    process.exit(1);
  }
  if (opts.task) return opts.task;
  const fromEnv = process.env.AGENTS_BROWSER_TASK;
  if (fromEnv) return fromEnv;
  return inferredTaskName;
}

// `-t` is taken by `--tab` on most commands, so `--task` is long-form only.
// The daemon resolves from caller identity when omitted.
const TASK_OPTION_FLAG = '--task <name>';
const TASK_OPTION_DESC =
  'Task name (defaults to $AGENTS_BROWSER_TASK, else the caller\'s live task)';
const DEVICE_ON_PAGE_VERB_FLAG = '--device <name>';
const DEVICE_ON_PAGE_VERB_DESC =
  'Not valid here — bind the device at `browser start --device`';

const TASK_ROUTED_COMMANDS = new Set([
  'stream',
  'done',
  'stop',
  'navigate',
  'goto',
  'tab',
  'tabs',
  'screenshot',
  'pdf',
  'evaluate',
  'text',
  'refs',
  'click',
  'type',
  'select',
  'press',
  'dialog',
  'hover',
  'scroll',
  'upload',
  'set',
  'console',
  'errors',
  'requests',
  'responsebody',
  'wait',
  'download',
  'record',
  'waitdownload',
]);

function commandPath(actionCommand: Command): string[] {
  const parts: string[] = [];
  let current: Command | null = actionCommand;
  while (current) {
    const name = current.name();
    if (name === 'agents' || name === 'browser') break;
    parts.unshift(name);
    current = current.parent ?? null;
  }
  return parts;
}

/** The verb as typed, minus `--device` (and `drop`), for the remote CLI to re-parse. */
function browserForwardedArgv(command: Command, drop: string[] = [], insert: string[] = []): string[] {
  const raw = process.argv.slice(2);
  const withCommand = raw[0] === 'browser' ? raw : ['browser', ...raw];
  return forwardedCommandArgv(withCommand, command, ['device', ...drop], insert);
}

async function dispatchBrowserToDevice(
  device: string,
  forwardedArgs: string[],
  mode: 'stream' | 'capture',
): Promise<{ code: number; stdout: string; stderr: string }> {
  const identityEnv = callerIdentityEnv(resolveCallerIdentity());
  const relay = relayFromEnv();
  if (relay) {
    const result = await relayExec(relay, device, forwardedArgs, { ...identityEnv, [FLEET_REMOTE_ENV]: '1' });
    if (mode === 'capture') return result;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return { code: result.code, stdout: '', stderr: '' };
  }
  const host = await resolveHost(device);
  if (!host) {
    throw new Error(
      `Unknown device "${device}". Next: add a Host alias for it in ~/.ssh/config, or pass user@host`,
    );
  }
  // Forward caller identity to isolate hub tasks; the fleet marker drives the hub's remote-control
  // consent check.
  const remoteCmd = buildRemoteBrowserCommand(forwardedArgs, { ...identityEnv, [FLEET_REMOTE_ENV]: '1' });
  if (mode === 'stream') {
    const interactive = isatty(1) && !process.argv.includes('--no-tty');
    return { code: streamOnHost(host, remoteCmd, interactive), stdout: '', stderr: '' };
  }
  const result = captureOnHost(host, remoteCmd);
  return {
    code: result.code ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function remoteStartTaskName(stdout: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const decoded = JSON.parse(trimmed) as { task?: unknown };
    if (typeof decoded.task === 'string' && decoded.task.length > 0) return decoded.task;
  } catch {
    // Human output is one task name on the first non-empty line.
  }
  return trimmed.split('\n').map((line) => line.trim()).find(Boolean);
}

async function pullRemoteFile(device: string, remotePath: string, localPath: string): Promise<void> {
  const relay = relayFromEnv();
  if (relay) {
    fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
    fs.writeFileSync(path.resolve(localPath), await relayFetchFile(relay, device, remotePath));
    return;
  }
  const host = await resolveHost(device);
  if (!host) {
    throw new Error(`Unknown device "${device}". Next: add a Host alias for it in ~/.ssh/config, or pass user@host`);
  }
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
  const copied = copyFromHost(host, remotePath, path.resolve(localPath));
  if (copied.status !== 0) {
    throw new Error(
      `Failed to copy screenshot from ${device}:${remotePath}: ${(copied.stderr || copied.stdout || '').trim()}`,
    );
  }
}

/** The AGI Ext's remote-artifacts layout: showing the same file again lands on the same path and reuses its tab. */
async function pushShowFile(device: string, localPath: string): Promise<string> {
  if (!fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`${localPath} is not a file.`);
  if (relayFromEnv()) throw new Error(`The relay cannot carry ${localPath} to ${device}; show a URL ${device} can reach instead.`);
  const host = await resolveHost(device);
  if (!host) {
    throw new Error(`Unknown device "${device}". Next: add a Host alias for it in ~/.ssh/config, or pass user@host`);
  }
  const relative = path.posix.join('.agents/.cache/remote-artifacts', machineId(), localPath.split(path.sep).join('/'));
  const prepared = captureOnHost(host, `mkdir -p ${shellQuote(path.posix.dirname(relative))} && printf %s "$HOME"`);
  if (prepared.code !== 0 || !prepared.stdout.trim()) {
    throw new Error(`Could not make a folder for ${path.basename(localPath)} on ${device}: ${(prepared.stderr || prepared.stdout).trim()}`);
  }
  const remotePath = `${prepared.stdout.trim()}/${relative}`;
  const copied = copyToHost(host, localPath, remotePath);
  if (copied.status !== 0) {
    throw new Error(`Failed to copy ${localPath} to ${device}: ${(copied.stderr || copied.stdout || '').trim()}`);
  }
  return remotePath;
}

async function showOnHub(
  hub: string,
  url: string,
  isLocalFile: boolean,
  opts: { profile?: string; osBrowser?: boolean; fresh?: boolean },
): Promise<ShowOutcome & { device: string }> {
  try {
    const local = isLocalFile ? path.resolve(url) : /^file:/i.test(url) ? fileURLToPath(url) : undefined;
    const target = local === undefined ? url : await pushShowFile(hub, local);
    const result = await dispatchBrowserToDevice(hub, [
      'browser', 'show', target,
      ...(opts.profile ? ['--profile', opts.profile] : []),
      ...(opts.osBrowser ? ['--os-browser'] : []),
      ...(opts.fresh ? ['--fresh'] : []),
      '--json',
    ], 'capture');
    process.stderr.write(result.stderr);
    try {
      return { ...(JSON.parse(result.stdout) as ShowOutcome), device: hub };
    } catch {
      return { via: 'none', device: hub, reason: result.stderr.trim().split('\n').pop() || `browser show exited ${result.code}` };
    }
  } catch (err) {
    return { via: 'none', device: hub, reason: err instanceof Error ? err.message : String(err) };
  }
}

function syncTaskIndex(request: IPCRequest, response: IPCResponse): void {
  if (!response.ok) return;
  if (request.action === 'stop' && request.profile && !request.task) {
    unbindTasksForProfile(request.profile);
    return;
  }
  if (request.action === 'gc') {
    if (!request.dryRun) {
      for (const closed of response.reaped?.closed ?? []) {
        unbindTask(closed.task);
      }
    }
    return;
  }
  const name = response.task ?? request.task ?? request.taskName;
  if (!name) return;
  if (request.action === 'done' || (request.action === 'stop' && request.task)) {
    unbindTask(name);
    return;
  }
  if (request.action === 'start') {
    const existing = getTaskBinding(name);
    if (!existing) {
      bindTask(name, {
        device: machineId(),
        profile: request.profile,
        url: request.url,
        sessionId: request.sessionId ?? resolveCallerIdentity().sessionId,
        launchId: request.launchId ?? resolveCallerIdentity().launchId,
        createdAt: Date.now(),
      });
    } else if (request.url) {
      updateTaskBinding(name, { url: request.url });
    }
    return;
  }
  if (request.url) {
    const existing = getTaskBinding(name);
    if (existing) {
      updateTaskBinding(name, { url: request.url });
    } else {
      bindTask(name, {
        device: machineId(),
        profile: request.profile,
        url: request.url,
        sessionId: request.sessionId ?? resolveCallerIdentity().sessionId,
        launchId: request.launchId ?? resolveCallerIdentity().launchId,
        createdAt: Date.now(),
      });
    }
    return;
  }
  if (!getTaskBinding(name)) {
    bindTask(name, {
      device: machineId(),
      profile: request.profile,
      sessionId: request.sessionId ?? resolveCallerIdentity().sessionId,
      launchId: request.launchId ?? resolveCallerIdentity().launchId,
      createdAt: Date.now(),
    });
  }
}

async function sendIPCRequest(
  request: IPCRequest,
  opts?: IPCRequestOptions,
): Promise<IPCResponse> {
  const response = await sendRawIPCRequest(request, opts);
  syncTaskIndex(request, response);
  return response;
}

function assertDeviceDeclaresProfile(device: string, profileName: string): void {
  const declared = declaringDevices(profileName);
  if (declared.includes(device)) return;
  const where =
    declared.length > 0
      ? `Declared on: ${declared.join(', ')}.`
      : 'No device declares that profile.';
  throw new Error(
    `Device "${device}" does not declare browser profile "${profileName}". ${where}\n` +
      `Next: run \`browser profiles add ${profileName} --browser <b>\` on ${device}.`,
  );
}

/** Return the configured hub unless already on it or fleet-dispatched, preventing forwarding loops. */
export function defaultBrowserHub(): string | undefined {
  if (isFleetRemoteInvocation()) return undefined;
  const hub = getConfigValue('browser.device').value as string | undefined;
  if (!hub || isSelfHost(hub)) return undefined;
  return hub;
}

// Help groups — surfaces the actual mental model an agent follows
// ("open a session / drive the page / capture evidence / rare extras")
// instead of an alphabetical dump. Everything not listed falls into a
// trailing "Other commands" section automatically.
const BROWSER_HELP_GROUPS = [
  { title: 'Session lifecycle', names: ['use', 'start', 'done', 'status', 'prune'] },
  { title: 'Fast action loop', names: ['stream'] },
  {
    title: 'Drive the page',
    names: ['navigate', 'tabs', 'text', 'screenshot', 'evaluate', 'click', 'type', 'select', 'press', 'dialog', 'wait'],
  },
  {
    title: 'Capture evidence',
    names: ['console', 'errors', 'requests', 'responsebody', 'record', 'pdf'],
  },
  { title: 'History and discovery', names: ['sessions', 'history', 'refs'] },
  { title: 'Help and skill', names: ['help', 'skills'] },
] as const;

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Launch and drive browser profiles via the Chrome DevTools Protocol. Power-tool for the `browser` skill.');

  setHelpSections(browser, {
    examples: `
      # List configured browser profiles
      browser profiles list

      # Create a Chrome profile pointed at a CDP endpoint
      browser profiles create work --browser chrome --endpoint http://localhost:9222

      # Start a session on this machine's default browser (set it once with: browser use)
      browser start

      # Or pin to a specific profile
      browser start --profile work

      # Drive the page (no start / --task needed — identity resolves the task)
      browser navigate https://example.com
      browser screenshot

      # Every tab open in the profile browser, yours next to the task's (OWNER column)
      browser tabs --all

      # Keep one process and browser-service socket warm for repeated actions
      browser stream --task "$AGENTS_BROWSER_TASK"

      # Bind a device at start; later verbs resolve it from the task
      browser start --task post --device laptop --url https://x.com/
      browser refs --task post
      browser type 3 --text "hello" --task post
      browser screenshot --task post

      # Browse a task-heavy profile's captures: one row per task, not per file
      browser sessions

      # Allow / deny other fleet machines driving THIS machine's browser
      browser remote-control on

      # End the session when done
      browser done

      # Close tabs the daemon's own reaper would have caught on its next 5-min tick
      browser prune --dry-run

      # Recover browser IPC without interrupting routines, usage, or secrets:
      # stop only the browser service, then start it clean
      browser stop --service
      browser start
    `,
    notes: `
      Most agent workflows should use the 'browser' skill instead of raw subcommands.
      The skill wraps profile selection, snapshotting, and tunneling.

      Browser support: Chromium-family over the Chrome DevTools Protocol (Chrome,
      Comet, Chromium, Brave, Edge), Arc natively (one profile per Space), and
      Firefox over WebDriver BiDi (one profile per profiles.ini entry; Firefox 129+
      dropped CDP). Safari is not supported. On Windows, Edge is the default
      because it's preinstalled. On macOS and Linux, Chrome is preferred when
      installed; otherwise the first Chromium-family binary on disk wins.
    `,
  });

  registerBrowserUseCommand(browser);
  registerProfilesCommands(browser);
  registerTaskCommands(browser);
  registerCommandGroups(browser, BROWSER_HELP_GROUPS);
}

export function registerBrowserSubcommands(program: Command): void {
  registerBrowserUseCommand(program);
  registerProfilesCommands(program);
  registerTaskCommands(program);
  registerSkillsCommand(program);
  registerHelpJsonCommand(program);
  registerCommandGroups(program, BROWSER_HELP_GROUPS);
}

interface BrowserUseOptions {
  unset?: boolean;
}

interface BrowserUseChoice {
  name: string;
  value: { name: string; installed?: ReturnType<typeof listInstalledBrowsers>[number] };
}

export function buildBrowserUseChoices(
  profiles: BrowserProfile[],
  installed: ReturnType<typeof listInstalledBrowsers>,
  current?: string,
): BrowserUseChoice[] {
  const choices: BrowserUseChoice[] = profiles.map((profile) => ({
    name: `${profile.name}${profile.name === current ? ' (current)' : ''}`,
    value: { name: profile.name },
  }));
  const known = new Set(profiles.map((profile) => profile.name));
  for (const browser of installed) {
    const name = `${browser.browserType}-local`;
    if (!known.has(name)) {
      choices.push({ name: `${name} (installed ${browser.browserType})`, value: { name, installed: browser } });
    }
  }
  return choices;
}

export async function runBrowserUse(
  name: string | undefined,
  opts: BrowserUseOptions,
  interactive = isInteractiveTerminal(),
): Promise<boolean> {
  if (opts.unset || name === 'auto') {
    unsetConfigValue('browser.profile');
    console.log('Default browser profile cleared. Pick one with `browser use <name>`; until then `browser start` has no default to launch here.');
    return true;
  }

  let selectedName = name;
  if (!selectedName) {
    const current = getConfiguredDefaultProfileName();
    if (!interactive) {
      console.log(current
        ? `Default browser profile (this machine): ${current}`
        : 'Default browser profile (this machine): none — pick one with `browser use <name>`');
      const hub = getConfigValue('browser.device').value as string | undefined;
      if (hub) {
        console.log(
          isSelfHost(hub)
            ? `Browser hub (browser.device): ${hub} — this machine, so drives locally`
            : `Browser hub (browser.device): ${hub} — bare \`browser start\` drives ${hub}'s browser`,
        );
      }
      console.log('Usage: browser use <name>  (or --unset)');
      return true;
    }

    const choices = buildBrowserUseChoices(await listProfiles(), listInstalledBrowsers(), current);
    if (choices.length === 0) {
      console.error('No configured profiles or supported installed browsers found.');
      console.error('Create one with: browser profiles create <name> --browser chrome');
      return false;
    }
    const { select } = await import('@inquirer/prompts');
    const selected = await select({ message: 'Select default browser profile:', choices });
    selectedName = selected.name;
    if (selected.installed) {
      const freePort = await findFreeProfilePort();
      await createProfile({
        name: selected.name,
        description: `Seeded ${selected.installed.browserType} profile`,
        browser: selected.installed.browserType,
        binary: selected.installed.binary,
        endpoints: [`cdp://127.0.0.1:${freePort}`],
        viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
      });
    }
  }

  const target = await getProfile(selectedName);
  if (!target) {
    console.error(`Profile "${selectedName}" not found.`);
    const all = await listProfiles();
    if (all.length > 0) console.error(`Available profiles: ${all.map((profile) => profile.name).join(', ')}`);
    return false;
  }
  await persistDiscoveredProfile(selectedName);
  setConfigValue('browser.profile', selectedName);
  const endpoint = Object.values(getEndpointPresets(target))[0]?.target ?? '';
  console.log(`Default browser profile (this machine) is now "${selectedName}" (${target.browser}${endpoint ? `, ${endpoint}` : ''}).`);
  console.log('Bare `browser start` and `--profile default` will use it.');
  return true;
}

function configureBrowserUseCommand(command: Command, deprecated = false): void {
  command
    .description('Pick the profile `browser start` uses when no --profile is passed. No name opens a picker on a TTY or prints the current default headlessly.')
    .option('--unset', 'Clear the configured default (leaves this machine with no default until you pick one)')
    .action(async (name: string | undefined, opts: BrowserUseOptions) => {
      if (deprecated) {
        console.warn(chalk.yellow('Deprecation: `browser profiles set-default` is replaced by `browser use`.'));
      }
      if (!await runBrowserUse(name, opts)) process.exitCode = 1;
    });
}

function registerBrowserUseCommand(browser: Command): void {
  configureBrowserUseCommand(browser.command('use [name]'));
}

/** Inspect credential key names only; return bundle, '-', or '(unknown)' without prompting or
 * decrypting values. */
async function credAvailability(bundleName: string | undefined, service: string): Promise<string> {
  if (!bundleName) return '-';
  const keys = credKeysForService(service);
  if (!keys) return '-';
  try {
    if (!(await bundleExists(bundleName))) return '-';
    const present = new Set(Object.keys((await readBundle(bundleName)).vars));
    return present.has(keys.user) && present.has(keys.pass) ? bundleName : '-';
  } catch {
    return '(unknown)';
  }
}

function registerProfilesCommands(browser: Command): void {
  const profiles = browser
    .command('profiles')
    .description('Manage browser profiles');

  profiles
    .command('list')
    .alias('ls')
    .description('List all browser profiles and the devices declaring each one (WHERE)')
    .option('--json', 'Output machine-readable JSON (includes devices + kind)')
    .action(async (opts: { json?: boolean }) => {
      const allProfiles = await listProfiles();
      const configuredDefault = getConfiguredDefaultProfileName();

      if (opts.json) {
        console.log(JSON.stringify(
          allProfiles.map((profile) => ({
            ...profile,
            devices: profile.devices,
            kind: profile.arc || profile.firefox ? 'identity' : profileKind(profile.name),
            isConfiguredDefault: profile.name === configuredDefault,
          })),
          null,
          2,
        ));
        return;
      }

      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        console.log('Create one with: browser profiles create <name> --browser chrome');
        return;
      }

      // Rendering lives in lib/browser/profiles.ts so the column widths and the
      // default-marking rules are unit-tested rather than eyeballed.
      for (const line of formatProfilesTable(allProfiles, configuredDefault)) console.log(line);
    });

  profiles
    .command('seed')
    .description('Create a machine-local profile for each installed browser (named <browser>-local), so you can pick or use one instead of hand-crafting each. Idempotent — existing profiles are left untouched.')
    .action(async () => {
      const installed = listInstalledBrowsers();
      if (installed.length === 0) {
        console.error('No supported browser found to seed a profile for.');
        process.exit(1);
      }
      for (const { browserType, binary } of installed) {
        const name = `${browserType}-local`;
        if (await getProfile(name)) {
          console.log(`= ${name} (already exists)`);
          continue;
        }
        const freePort = await findFreeProfilePort();
        await createProfile({
          name,
          description: `Seeded ${browserType} profile`,
          browser: browserType,
          binary,
          endpoints: [`cdp://127.0.0.1:${freePort}`],
          viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
        });
        console.log(`+ ${name} (${browserType})`);
      }
      console.log('Pick your default with: browser use <name>');
    });

  profiles
    .command('claim [name]')
    .description(
      'Move leftover central browser: profiles into this device\'s declaration file. Only profiles this machine can host are claimed; the rest stay central. Run on the machine that actually has the browser.',
    )
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      const canHostHere = (config: BrowserProfileConfig): boolean =>
        isProfileLaunchableHere({
          name: '_',
          browser: config.browser,
          binary: config.binary,
          endpoints: config.endpoints,
        });

      let result;
      try {
        result = migrateCentralBrowserProfiles(canHostHere, name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...result, device: machineId() }, null, 2));
        return;
      }

      if (result.claimed.length === 0 && result.skipped.length === 0) {
        console.log('No leftover central browser profiles to claim.');
        return;
      }
      for (const claimed of result.claimed) {
        console.log(`Claimed ${claimed} on ${machineId()}`);
      }
      for (const skipped of result.skipped) {
        console.log(
          `Skipped ${skipped}: this machine cannot host it (browser/binary isn't installed here). ` +
            `Run \`browser profiles claim ${skipped}\` on the machine that has that browser.`,
        );
      }
      if (result.claimed.length === 0) {
        console.log('No leftover central profiles this machine can host.');
      }
    });

  configureBrowserUseCommand(profiles.command('use [name]'));
  configureBrowserUseCommand(profiles.command('set-default [name]', { hidden: true }), true);

  profiles
    .command('logins')
    .description('Show which login-gated services each profile has a live session for, the account signed in, and whether login creds are available in the profile\'s secrets bundle (reads cookie/username presence only, never decrypts).')
    .option('--json', 'Output a flat JSON array: one {profile, service, account} row per detected login, plus one {profile, service: null, account: null, unread} row per profile whose cookie store cannot be read here')
    .action(async (opts: { json?: boolean }) => {
      const allProfiles = await listProfiles();
      if (opts.json) {
        const rows: Array<{ profile: string; service: string | null; account: string | null; unread?: string }> = [];
        for (const p of allProfiles) {
          const state = await loginsWithAccountsForProfile(p);
          if (state.unread) rows.push({ profile: p.name, service: null, account: null, unread: state.unread });
          for (const r of state.logins) {
            rows.push({ profile: p.name, service: r.service, account: r.username ?? '' });
          }
        }
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (allProfiles.length === 0) {
        console.log('No browser profiles configured.');
        return;
      }
      console.log('PROFILE'.padEnd(20) + 'SERVICE'.padEnd(12) + 'ACCOUNT'.padEnd(32) + 'CREDS');
      console.log('-'.repeat(80));
      for (const p of allProfiles) {
        const state = await loginsWithAccountsForProfile(p);
        if (state.unread) {
          console.log(p.name.padEnd(20) + `(not read: ${state.unread})`);
          continue;
        }
        if (state.logins.length === 0) {
          console.log(p.name.padEnd(20) + '(none detected)');
          continue;
        }
        let first = true;
        for (const r of state.logins) {
          const name = first ? p.name : '';
          console.log(
            name.padEnd(20) +
              r.service.padEnd(12) +
              (r.username ?? '(unknown)').padEnd(32) +
              (await credAvailability(p.secrets, r.service)),
          );
          first = false;
        }
      }
    });

  const VALID_BROWSERS = ['chrome', 'comet', 'chromium', 'brave', 'edge', 'arc', 'custom'];

  profiles
    .command('create <name>')
    .alias('add')
    .description('Create a new browser profile on this device')
    .requiredOption('-b, --browser <type>', `Browser type: ${VALID_BROWSERS.join(', ')}`)
    .option('-e, --endpoint <url>', 'CDP endpoint URL (repeatable; auto-assigned if omitted)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('-d, --description <text>', 'Profile description')
    .option('--headless', 'Run in headless mode')
    .option('--window <WxH>', `Window size in CSS pixels (default: ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}, MacBook Pro 14")`)
    .option('--position <X,Y>', 'Window position on screen, e.g. 80,80')
    .option('--binary <path>', 'Absolute path to the browser/app binary (required with --browser custom)')
    .option(
      '--electron',
      'Treat this profile as an Electron desktop app: never call Target.createTarget; bind to the visible window using --target-filter or the skip-invisible heuristic'
    )
    .option(
      '--target-filter <expr>',
      'Pick the existing CDP page target to drive (Electron apps, and Arc — which reuses an open tab / Space rather than creating one). Format: url:<substring> or title:<substring>'
    )
    .option(
      '--attach-only',
      'Never spawn a rival window: attach to a browser you already started with remote debugging, else fail loud with a relaunch hint. The model for a canonical signed-in Comet; Arc is always attach-only. Pairs with a durable --user-data-dir.'
    )
    .option(
      '--user-data-dir <path>',
      "Absolute durable --user-data-dir for this profile's browser. Default for attach-only: ~/.agents/browser/logins/<name>/chrome-data (outside cache, so a one-time sign-in survives relaunch)."
    )
    .action(async (name: string, opts) => {
      try {
        assertRegistrableProfileName(name);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (!VALID_BROWSERS.includes(opts.browser)) {
        console.error(`Invalid browser type. Must be one of: ${VALID_BROWSERS.join(', ')}`);
        process.exit(1);
      }

      if (opts.browser === 'custom' && !opts.binary) {
        console.error('--browser custom requires --binary <path>');
        process.exit(1);
      }

      if (opts.targetFilter) {
        // Route through the same parser the runtime uses so the CLI gate matches
        // the runtime contract — `url:` (empty value) and `url: foo` (leading
        // whitespace) both pass a naive `kind` check but produce a silent
        // heuristic fallback at runtime.
        const parsed = parseTargetFilter(String(opts.targetFilter));
        if (!parsed) {
          console.error('--target-filter must be url:<substring> or title:<substring> (non-empty value, no leading whitespace)');
          process.exit(1);
        }
        // Only Electron and Arc reuse existing targets; other browsers create tabs and do not consult
        // targetFilter.
        if (!opts.electron && opts.browser !== 'arc') {
          console.error('--target-filter requires --electron or --browser arc (the filter is only consulted on profiles that reuse an existing tab)');
          process.exit(1);
        }
      }

      // Auto-assign a free port if no endpoint was provided
      let endpoints: string[] = opts.endpoint;
      if (endpoints.length === 0) {
        const freePort = await findFreeProfilePort();
        endpoints = [`cdp://127.0.0.1:${freePort}`];
      }

      // Viewport is mandatory — default to MacBook Pro 14" (1512x982) if
      // --window is not provided. See lib/browser/devices.ts DEFAULT_VIEWPORT.
      let viewport: { width: number; height: number; x?: number; y?: number } = {
        width: DEFAULT_VIEWPORT.width,
        height: DEFAULT_VIEWPORT.height,
      };
      if (opts.window) {
        const size = parseWindowSize(String(opts.window));
        if (!size) {
          console.error(`--window must be WxH, e.g. ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height}`);
          process.exit(1);
        }
        viewport.width = size.width;
        viewport.height = size.height;
      }
      if (opts.position) {
        const pos = parseWindowPosition(String(opts.position));
        if (!pos) {
          console.error('--position must be X,Y, e.g. 80,80');
          process.exit(1);
        }
        viewport.x = pos.x;
        viewport.y = pos.y;
      }

      if (opts.userDataDir && !path.isAbsolute(String(opts.userDataDir))) {
        console.error('--user-data-dir must be an absolute path');
        process.exit(1);
      }

      const profile: BrowserProfile = {
        name,
        description: opts.description,
        browser: opts.browser,
        binary: opts.binary,
        electron: opts.electron || undefined,
        targetFilter: opts.targetFilter,
        endpoints,
        launchPolicy: opts.attachOnly ? 'attach-only' : undefined,
        userDataDir: opts.userDataDir ? String(opts.userDataDir) : undefined,
        secrets: opts.secrets,
        chrome: opts.headless ? { headless: true } : undefined,
        viewport,
      };

      await createProfile(profile);
      const port = extractConfiguredPort(profile);
      console.log(
        port !== undefined
          ? `Added "${name}" on ${machineId()} (port ${port}).`
          : `Added "${name}" on ${machineId()}.`,
      );
      // Attach-only profiles never launch a browser — tell the user the one-time
      // relaunch that makes their canonical instance attachable, pinned to the
      // durable data dir so the sign-in persists.
      if (isAttachOnlyProfile(profile) && profile.browser !== 'arc' && port !== undefined) {
        const app = profile.browser === 'comet' ? 'Comet' : profile.browser;
        console.log(
          `attach-only: browser will not spawn ${app}. Start the canonical one once with:\n` +
            `  open -a ${app} --args --remote-debugging-port=${port} --user-data-dir=${resolveProfileDataDir(profile)}\n` +
            `Sign in in that window; the data dir is durable so the login survives quit+relaunch.`,
        );
      }
      // Warn (don't fail) if the declared secrets bundle doesn't exist yet — it
      // may be created later, but a typo should surface now.
      if (opts.secrets && !(await bundleExists(opts.secrets))) {
        console.error(
          `warning: secrets bundle "${opts.secrets}" does not exist yet. Create it with: secrets create ${opts.secrets}`,
        );
      }
    });

  profiles
    .command('edit <name>')
    .description('Edit an existing profile in place (stays in the store it already lives in)')
    // Declared only so the action can explain WHY the browser type is not
    // editable. Without it commander rejects `-b` as an unknown option before
    // the action runs, and the delete-and-recreate guidance never reaches anyone.
    .option('-b, --browser <type>', 'Not editable — see the error for the delete-and-recreate path')
    .option('-d, --description <text>', "Profile description (pass '' to clear)")
    .option('-e, --endpoint <url>', 'Replace the endpoint list (repeatable)', collect, [])
    .option('-s, --secrets <bundle>', 'Secrets bundle to inject')
    .option('--headless', 'Run in headless mode')
    .option('--no-headless', 'Run headed')
    .option('--window <WxH>', 'Window size in CSS pixels')
    .option('--position <X,Y>', 'Window position on screen, e.g. 80,80')
    .option('--binary <path>', 'Absolute path to the browser/app binary')
    .option('--electron', 'Treat this profile as an Electron desktop app')
    .option('--no-electron', 'Stop treating it as an Electron app')
    .option('--target-filter <expr>', "url:<substring> or title:<substring>; consulted on Electron and Arc profiles (pass '' to clear)")
    .option('--attach-only', 'Make this profile attach-only (never spawn a rival window)')
    .option('--launch', 'Undo attach-only: let agents launch the browser when nothing is serving CDP on the port')
    .option('--user-data-dir <path>', "Absolute durable --user-data-dir (pass '' to clear back to the default durable dir)")
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      // The browser type and the name are identity, not settings: both key the
      // on-disk runtime dir and any live `<name>@<endpoint>` connection, so
      // changing either orphans the cached browser data (and its logins).
      if (opts.browser) {
        console.error(
          'browser type is not editable — it keys the on-disk profile cache. ' +
            `Remove and recreate instead: browser profiles remove ${name} && browser profiles create ${name} -b <type>`
        );
        process.exit(1);
      }

      if (opts.targetFilter) {
        const parsed = parseTargetFilter(String(opts.targetFilter));
        if (!parsed) {
          console.error('--target-filter must be url:<substring> or title:<substring> (non-empty value, no leading whitespace)');
          process.exit(1);
        }
      }

      if (opts.attachOnly && opts.launch) {
        console.error('Pass either --attach-only or --launch, not both.');
        process.exit(1);
      }
      if (opts.userDataDir && !path.isAbsolute(String(opts.userDataDir))) {
        console.error('--user-data-dir must be an absolute path');
        process.exit(1);
      }

      const patch: EditableProfileFields = {};
      if (opts.description !== undefined) patch.description = opts.description || undefined;
      if (opts.endpoint && opts.endpoint.length > 0) patch.endpoints = opts.endpoint;
      if (opts.secrets !== undefined) patch.secrets = opts.secrets;
      if (opts.binary !== undefined) patch.binary = opts.binary;
      if (opts.targetFilter !== undefined) patch.targetFilter = opts.targetFilter || undefined;
      // launchPolicy toggle: --attach-only sets it, --launch clears it (back to
      // the default launch behavior). commander leaves each undefined when unset.
      if (opts.attachOnly) patch.launchPolicy = 'attach-only';
      else if (opts.launch) patch.launchPolicy = undefined;
      // '' clears back to the default durable dir; any other value pins it.
      if (opts.userDataDir !== undefined) patch.userDataDir = opts.userDataDir || undefined;
      // commander maps --electron/--no-electron and --headless/--no-headless onto
      // one boolean each, and leaves it undefined when neither was passed.
      if (opts.electron !== undefined) patch.electron = opts.electron || undefined;

      if (opts.headless !== undefined || opts.window || opts.position) {
        const current = await getProfile(name);
        if (!current) {
          console.error(`Profile "${name}" does not exist`);
          process.exit(1);
        }
        if (opts.headless !== undefined) {
          const chrome = { ...current.chrome };
          if (opts.headless) chrome.headless = true;
          else delete chrome.headless;
          // `{ headless: undefined }` is truthy, so profileToConfig would persist
          // a bare `chrome: {}` into the YAML and the change-detector would report
          // a phantom edit on an already-headed profile. Drop the key entirely.
          patch.chrome = Object.keys(chrome).length > 0 ? chrome : undefined;
        }
        if (opts.window || opts.position) {
          const viewport = { ...(current.viewport ?? { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }) };
          if (opts.window) {
            const size = parseWindowSize(String(opts.window));
            if (!size) {
              console.error('--window must be WxH, e.g. 1512x982');
              process.exit(1);
            }
            viewport.width = size.width;
            viewport.height = size.height;
          }
          if (opts.position) {
            const pos = parseWindowPosition(String(opts.position));
            if (!pos) {
              console.error('--position must be X,Y, e.g. 80,80');
              process.exit(1);
            }
            viewport.x = pos.x;
            viewport.y = pos.y;
          }
          patch.viewport = viewport;
        }
      }

      if (Object.keys(patch).length === 0) {
        console.error('Nothing to edit. Pass at least one field, e.g. -d "<description>".');
        process.exit(1);
      }

      let result;
      try {
        result = await editProfile(name, patch);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...result.profile, devices: result.devices, changed: result.changed }, null, 2));
      } else if (result.changed.length === 0) {
        console.log(`No change: ${name} already had those values.`);
      } else {
        console.log(`Updated ${name} on ${machineId()}: ${result.changed.join(', ')}`);
      }
      if (patch.secrets && !(await bundleExists(patch.secrets))) {
        console.error(
          `warning: secrets bundle "${patch.secrets}" does not exist yet. Create it with: secrets create ${patch.secrets}`,
        );
      }
    });

  profiles
    .command('rename <from> <to>')
    .description("Rename a profile, moving its browser data with it (logins survive)")
    .option('--json', 'Output machine-readable JSON')
    .action(async (from: string, to: string, opts: { json?: boolean }) => {
      let res;
      try {
        res = await renameProfile(from, to);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ from, to, ...res }, null, 2));
        return;
      }
      console.log(`Renamed ${from} -> ${to} on ${machineId()}`);
      if (res.movedDirs.length > 0) {
        console.log(`  moved ${res.movedDirs.length} browser data dir${res.movedDirs.length === 1 ? '' : 's'} — logins preserved`);
      }
      if (res.repointedDefault) {
        console.log(`  browser.profile now points at ${to}`);
      }
      if (res.repointedViewer) {
        console.log(`  browser.viewer now points at ${to}`);
      }
      if (res.stalePins.length > 0) {
        const devices = [...new Set(res.stalePins.map((p) => p.device))];
        const one = devices.length === 1;
        console.error(
          `warning: ${devices.join(', ')} still ${one ? 'pins' : 'pin'} "${from}" in ` +
            `${one ? 'its' : 'their'} own device config. Fix with:`,
        );
        for (const pin of res.stalePins) {
          console.error(`  on ${pin.device}: set ${pin.key} to ${to} in that device's agents.yaml`);
        }
      }
    });

  profiles
    .command('view <name>')
    .alias('show')
    .description('View one profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (name: string, opts) => {
      const profile = await getProfile(name);
      if (!profile) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: `Profile "${name}" not found` }));
        } else {
          console.error(`Profile "${name}" not found`);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(profile, null, 2));
        return;
      }

      console.log(`Name: ${profile.name}`);
      console.log(`Browser: ${profile.browser}`);
      if (getConfiguredDefaultProfileName() === profile.name) {
        console.log('Default: yes (this machine — used by `browser start`)');
      }
      if (profile.binary) console.log(`Binary: ${profile.binary}`);
      if (profile.electron) console.log(`Electron: true`);
      if (isAttachOnlyProfile(profile)) {
        const why = profile.browser === 'arc' ? ' (Arc is always attach-only)' : '';
        console.log(`Launch policy: attach-only${why} — agents attach, never spawn a rival window`);
        if (profile.browser !== 'arc') {
          console.log(`User-data-dir: ${resolveProfileDataDir(profile)} (durable)`);
        }
      }
      if (profile.targetFilter) console.log(`Target filter: ${profile.targetFilter}`);
      if (profile.description) console.log(`Description: ${profile.description}`);
      if (profile.arc) console.log(`Arc profile: ${profile.arc.profileName} (${profile.arc.profileId})`);
      if (profile.firefox) {
        console.log(`Firefox profile: ${profile.firefox.profileName}${profile.firefox.isDefault ? ' (default)' : ''}`);
        if (profile.userDataDir) console.log(`Profile directory: ${profile.userDataDir}`);
      }
      const presets = getEndpointPresets(profile);
      const defaultName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
        ? profile.defaultEndpoint
        : Object.keys(presets)[0];
      console.log('Endpoints:');
      for (const [presetName, preset] of Object.entries(presets)) {
        const marker = presetName === defaultName ? ' (default)' : '';
        const isLegacy = presetName.startsWith('endpoint-');
        console.log(`  - ${isLegacy ? preset.target : `${presetName}: ${preset.target}`}${marker}`);
        if (preset.binary) console.log(`      binary: ${preset.binary}`);
        if (preset.targetFilter) console.log(`      targetFilter: ${preset.targetFilter}`);
      }
      if (profile.viewport) {
        const v = profile.viewport;
        const pos = v.x !== undefined && v.y !== undefined ? ` @ ${v.x},${v.y}` : '';
        console.log(`Viewport: ${v.width}×${v.height}${pos}`);
      }
      if (profile.secrets) console.log(`Secrets: ${profile.secrets}`);
      if (profile.chrome?.headless) console.log(`Headless: true`);

      // Login state per known service: live session + account identity + whether
      // login creds are declared in the profile's secrets bundle.
      const state = await loginsWithAccountsForProfile(profile);
      if (state.unread) {
        console.log(`Logins: not read (${state.unread})`);
        return;
      }
      const lines: string[] = [];
      for (const service of Object.keys(AUTH_SIGNATURES)) {
        const login = state.logins.find((l) => l.service === service);
        const creds = await credAvailability(profile.secrets, service);
        if (!login && creds === '-') continue; // nothing interesting to show
        const status = login
          ? `logged in${login.username ? ` as ${login.username}` : ''}`
          : 'logged out';
        const credNote = creds !== '-' ? `  creds: ${creds}` : '';
        lines.push(`  ${service.padEnd(10)} ${status}${credNote}`);
      }
      if (lines.length > 0) {
        console.log('Logins:');
        for (const l of lines) console.log(l);
      }
    });

  profiles
    .command('remove <name>')
    .alias('delete')
    .description('Remove the profile alias and cached runtime dirs (never deletes native Arc data)')
    .option('--keep-cache', "Leave ~/.agents/browser/cache/<name>* dirs in place (don't wipe chrome-data)")
    .action(async (name: string, opts: { keepCache?: boolean }) => {
      await deleteProfile(name);
      // The composite naming change introduced multiple cache dirs per
      // profile (`<name>`, `<name>@endpoint-0`, …). Sweep them all unless
      // the user explicitly wants the chrome-data preserved (e.g. for
      // re-import into a freshly-created profile of the same name).
      let removed = 0;
      if (!opts.keepCache) {
        const cacheDirs = listProfileCacheDirs(name);
        removed = cacheDirs.length;
        for (const dir of cacheDirs) {
          // `removeProfileCache` operates by profile-name; for the
          // composite dirs we already have the absolute path. Use rmSync
          // directly so we don't depend on naming round-trips.
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        // The canonical wipe also covers the legacy dir if present.
        removeProfileCache(name);
      }
      console.log(
        `Deleted profile: ${name}` +
          (removed > 0 ? ` (and ${removed} cache dir${removed === 1 ? '' : 's'})` : '')
      );
      if (getConfiguredDefaultProfileName() === name) {
        console.error(
          `warning: "${name}" was this machine's default browser profile; ` +
          `\`browser start\` has no default here until you run: browser use <name>`
        );
      }
    });

  profiles
    .command('prune')
    .description('Remove dead profiles this device declares: browser not installed here, or never started')
    .option('-n, --dry-run', 'Print what would be removed and exit without changing anything')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      const plan = await buildProfilePrunePlan();

      if (!opts.dryRun) await pruneProfiles(plan);

      if (opts.json) {
        console.log(JSON.stringify({ dryRun: !!opts.dryRun, ...plan }, null, 2));
        return;
      }

      // A misfiled profile is never a prune candidate — the entry belongs to the
      // device that declared it, not to this one — so without this it would only
      // ever surface in --json. It is the one kept-reason a user has to act on.
      const misfiled = plan.kept.filter((k) => k.misfiled);
      const reportMisfiled = (): void => {
        if (misfiled.length === 0) return;
        console.log('');
        console.log(
          `${misfiled.length} profile${misfiled.length === 1 ? '' : 's'} ${misfiled.length === 1 ? 'is' : 'are'} misfiled — ` +
            `declared on another device but bound to a loopback port, so the name resolves to ` +
            `this machine's own browser rather than the declaring device's:`
        );
        for (const k of misfiled) {
          console.log(`  ${k.name} — ${k.why}`);
        }
        console.log(
          'Re-declare each on the machine that owns the browser. Nothing was moved for you.'
        );
        console.log('(Prune never deletes these — the declaring device owns the entry.)');
      };

      if (plan.candidates.length === 0) {
        console.log('Nothing to prune — every profile is in use, healthy, or protected.');
        if (plan.kept.length > 0) {
          for (const k of plan.kept) console.log(`  kept ${k.name} (${k.scope}) — ${k.why}`);
        }
        reportMisfiled();
        return;
      }

      const verb = opts.dryRun ? 'Would remove' : 'Removed';
      console.log(`${verb} ${plan.candidates.length} profile${plan.candidates.length === 1 ? '' : 's'}:`);
      for (const c of plan.candidates) {
        const cache = c.cacheDirs.length > 0
          ? ` + ${c.cacheDirs.length} cache dir${c.cacheDirs.length === 1 ? '' : 's'}`
          : '';
        console.log(`  ${c.name} (${c.scope}) — ${PRUNE_REASON_TEXT[c.reason]}${c.duplicateOf ? ` ${c.duplicateOf}` : ''}${cache}`);
      }
      reportMisfiled();
      if (opts.dryRun) {
        console.log('');
        console.log('Nothing was changed. Re-run without --dry-run to apply.');
      }
    });

  setHelpSections(profiles, {
    examples: `
      # WHERE is the devices whose own file declares the name
      browser profiles list

      # Create one on this device
      browser profiles add work --browser chrome
      browser profiles create work --browser chrome

      # Claim leftover central profiles on the machine that hosts the browser
      browser profiles claim
      browser profiles claim comet-local

      # Clean up dead ones this device declares: check first, then apply
      browser profiles prune --dry-run
      browser profiles prune

      # Make one the machine's default for a bare \`browser start\`
      browser use work

      # Which profiles are signed in to which service, and as whom
      browser profiles logins
      browser profiles logins --json   # [{"profile","service","account"} | {"profile","service":null,"account":null,"unread"}]
    `,
    notes: `
      A device declares its own browsers in its own \`browser/profiles/<machine>.yaml\`.
      A name declared by exactly one device is identity-bearing; a name declared
      by several is fungible. Leftover central \`browser:\` entries are claimed
      with \`browser profiles claim\` on the machine that hosts the browser.

      In \`list\`, the \`*\` marker means "this machine's configured default"
      (\`browser start\` with no --profile). A profile a setup wizard pins
      is named \`auto-chrome\`; \`default\` is only an ALIAS for whichever profile
      this machine is configured to use, resolved the same way by every command.

      \`prune\` only considers profiles this device declares. It never removes a
      profile that is in use, the configured default, or the \`auto-chrome\`
      profile a setup wizard created.

      On a Mac with Arc, every Arc Space is listed as a profile (arc-home,
      arc-work, ...) discovered read-only from Arc's own metadata — a Space
      already carries its Arc profile's logins, so it IS the browser profile.
      Agents attach to the running Arc through Apple Events and never launch or
      relaunch it; their tabs open in an Arc window of their own. Comet's own profiles are listed the same way (comet-work, ...),
      pinned to Comet's real user-data dir, so agents and you share one Comet
      window per profile: agents attach when it is running with remote debugging,
      launch it on your store when it is not running, and fail loud with the
      relaunch command when it runs without a port. The daemon publishes every
      discovered profile into this device's declaration, so other fleet boxes list
      it with WHERE=<this device> and route to it. Point agents at Comet when a workflow needs
      downloads, network capture, or trusted input:
        browser profiles create agents-comet --browser comet --attach-only
      A CDP \`--attach-only\` profile attaches to a browser you
      already started with remote debugging and fails loud with the relaunch
      command otherwise, pinned to a durable --user-data-dir so the sign-in
      survives quit+relaunch. A foreign browser squatting the canonical port is
      rejected, not driven — \`browser profiles doctor <name>\` flags it.
    `,
  });

  profiles
    .command('doctor <name>')
    .description('Diagnose a browser profile: where it is declared, binary, port, user-data-dir, onboarding state')
    .action(async (name: string) => {
      const profile = await getProfile(name);
      if (!profile) {
        console.error(`Profile "${name}" not found`);
        process.exit(1);
      }

      if ((profile.arc || profile.firefox) && !isFleetRemoteInvocation()) {
        const routed = resolveBrowserTarget(profile.name);
        if (!routed.local) {
          const result = await dispatchBrowserToDevice(
            routed.device,
            ['browser', 'profiles', 'doctor', name],
            'capture',
          );
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          if (result.code !== 0) process.exit(result.code);
          return;
        }
      }

      const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

      // 0. Declaration topology. An identity-bearing profile declared by a
      //    different device cannot be diagnosed through a loopback CDP endpoint
      //    on this one — that is the original comet-local bug. Checked first
      //    because it invalidates every local check.
      const misfiled = identityLoopbackMismatch(profile);
      const kind = profileKind(profile.name);
      const where = profile.devices.length > 0 ? profile.devices.join(', ') : 'no device';
      checks.push(
        misfiled.misfiled
          ? { label: 'where', ok: false, detail: misfiled.why }
          : {
              label: 'where',
              ok: true,
              detail: kind
                ? `${kind}, declared on ${where}`
                : `declared on ${where}`,
            }
      );

      if (misfiled.misfiled) {
        for (const c of checks) {
          const marker = c.ok ? 'OK  ' : 'FAIL';
          console.log(`${marker}  ${c.label.padEnd(15)} ${c.detail}`);
        }
        process.exit(1);
      }

      if (profile.arc) {
        checks.push({
          label: 'arc-profile',
          ok: true,
          detail: `${profile.arc.profileName} (${profile.arc.profileId})`,
        });
        const running = await isArcRunning();
        checks.push({
          label: 'Arc process',
          ok: running,
          detail: running ? 'running; native automation attaches without launching or restarting Arc' : 'not running — start Arc normally',
        });
        const allOk = checks.every((check) => check.ok);
        for (const check of checks) {
          console.log(`${check.ok ? 'OK  ' : 'FAIL'}  ${check.label.padEnd(15)} ${check.detail}`);
        }
        if (!allOk) process.exit(1);
        return;
      }

      // Reject unresolved launcher scripts: wrapper re-exec breaks the remote-debugging-pipe
      // transport.
      try {
        const binPath = findBrowserPath(profile.browser, profile.binary);
        if (isLauncherScript(binPath)) {
          checks.push({
            label: 'binary',
            ok: false,
            detail:
              `${binPath} is a launcher script, not the browser executable — ` +
              `browser drives the browser over --remote-debugging-pipe and ` +
              `can't attach to a wrapper that re-execs it. Point the profile at the ` +
              `real binary (\`--binary /path/to/browser\`) or reinstall the standard package.`,
          });
        } else {
          checks.push({ label: 'binary', ok: true, detail: binPath });
        }
      } catch (err) {
        checks.push({
          label: 'binary',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // Probe local CDP ports locally; remote SSH browser state requires an explicit remote probe.
      const port = extractConfiguredPort(profile);
      let attachingToExistingBrowser = false;
      const firstEndpointTarget = (() => {
        const presets = getEndpointPresets(profile);
        const first = Object.keys(presets)[0];
        return first ? presets[first].target : undefined;
      })();
      const isSshEndpoint = firstEndpointTarget?.startsWith('ssh://') ?? false;
      if (port === undefined) {
        checks.push({ label: 'port', ok: true, detail: 'no port in endpoint' });
      } else if (isSshEndpoint) {
        checks.push({
          label: 'port',
          ok: true,
          detail: `${port} (remote on ${firstEndpointTarget}) — skipping local check`,
        });
      } else {
        const occupant = getPortOccupant(port);
        if (!occupant) {
          // Local launches use a debugging pipe; the configured port is only for attaching, so free
          // does not prove launch readiness.
          checks.push({
            label: 'port',
            ok: true,
            detail: `${port} free — will self-launch over an internal pipe (port used only to attach to an already-running browser)`,
          });
        } else {
          try {
            const { browser } = await discoverBrowserWsUrl(port, 'localhost', profile.name);
            verifyBrowserIdentity(browser, profile.browser, port);
            // Verify attach-only data-dir ownership; matching browser family alone could accept a
            // signed-out port squatter.
            const expectedDir = resolveProfileDataDir(profile);
            const ownershipChecked = isAttachOnlyProfile(profile) && profile.browser !== 'arc';
            const runningDir = ownershipChecked ? getProcessUserDataDir(occupant.pid) : null;
            if (runningDir && normalizeDataDir(runningDir) !== normalizeDataDir(expectedDir)) {
              checks.push({
                label: 'port',
                ok: false,
                detail:
                  `${port} serving ${browser} (pid ${occupant.pid}) but from a FOREIGN ` +
                  `user-data-dir ${runningDir} (expected ${expectedDir}). This is a ` +
                  `port-squatter, not this profile's browser — browser will refuse to drive ` +
                  `it. Close it (\`kill ${occupant.pid}\`) and relaunch the canonical browser ` +
                  `with --user-data-dir=${expectedDir}.`,
              });
            } else if (ownershipChecked && !runningDir) {
              // Attach-only, an occupant is serving CDP, but its --user-data-dir
              // couldn't be read — ownership is UNVERIFIED. Surface it rather than
              // report a silent green, matching the runtime guard which refuses to
              // attach to an unverifiable instance.
              checks.push({
                label: 'port',
                ok: false,
                detail:
                  `${port} serving ${browser} (pid ${occupant.pid}) but its --user-data-dir ` +
                  `could not be read, so ownership can't be confirmed. browser will refuse to ` +
                  `attach to an unverified instance. Relaunch the canonical browser with ` +
                  `--user-data-dir=${expectedDir} so the attach-only guard can verify it.`,
              });
            } else {
              checks.push({
                label: 'port',
                ok: true,
                detail: `${port} serving ${browser} (pid ${occupant.pid})`,
              });
              attachingToExistingBrowser = true;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            checks.push({
              label: 'port',
              ok: false,
              detail: `${port} taken by ${occupant.command} (pid ${occupant.pid}) — ${msg}`,
            });
          }
        }
      }

      // 3. User-data-dir exists and is writable. An attach-only profile's login
      //    lives in the DURABLE dir (outside .cache) the canonical browser is
      //    launched with; a launch-policy profile uses the managed cache dir.
      const userDataDir = isAttachOnlyProfile(profile) && profile.browser !== 'arc'
        ? resolveProfileDataDir(profile)
        : path.join(getProfileRuntimeDir(name), 'chrome-data');
      try {
        if (!fs.existsSync(userDataDir)) {
          checks.push({
            label: 'user-data-dir',
            ok: true,
            detail: `will be created at ${userDataDir}`,
          });
        } else {
          fs.accessSync(userDataDir, fs.constants.W_OK);
          checks.push({ label: 'user-data-dir', ok: true, detail: userDataDir });
        }
      } catch (err) {
        checks.push({
          label: 'user-data-dir',
          ok: false,
          detail: `${userDataDir} not writable: ${err instanceof Error ? err.message : err}`,
        });
      }

      // 4. Onboarding heuristic — only meaningful when WE will launch the
      // browser. When the configured port is already serving a debuggable
      // browser, that browser owns its own user-data-dir and the priming
      // status of our managed dir is irrelevant.
      if (attachingToExistingBrowser) {
        checks.push({
          label: 'onboarding',
          ok: true,
          detail: 'n/a (attaching to existing browser)',
        });
      } else {
        const localStatePath = path.join(userDataDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
          const size = fs.statSync(localStatePath).size;
          if (size > 0) {
            checks.push({ label: 'onboarding', ok: true, detail: 'Local State present' });
          } else {
            checks.push({
              label: 'onboarding',
              ok: false,
              detail:
                'Local State is empty — run `browser start --profile ' +
                name +
                '` and finish any first-run screens before automating',
            });
          }
        } else {
          checks.push({
            label: 'onboarding',
            ok: false,
            detail:
              'Not initialized yet — run `browser start --profile ' +
              name +
              '` and finish any first-run screens before automating',
          });
        }
      }

      const allOk = checks.every((c) => c.ok);
      for (const c of checks) {
        const marker = c.ok ? 'OK  ' : 'FAIL';
        console.log(`${marker}  ${c.label.padEnd(15)} ${c.detail}`);
      }
      if (!allOk) process.exit(1);
    });

}

function registerTaskCommands(browser: Command): void {
  browser.hook('preAction', async (_thisCommand, actionCommand) => {
    inferredTaskName = undefined;
    if (isFleetRemoteInvocation()) return;

    const pathNames = commandPath(actionCommand);
    const top = pathNames[0];
    if (!top || !TASK_ROUTED_COMMANDS.has(top)) return;
    if (pathNames.length === 1 && top === 'start') return;

    const opts = actionCommand.opts() as { task?: string; device?: string; profile?: string; output?: string; service?: boolean; daemon?: boolean };
    const deviceFlag = opts.device;
    const taskFlag = opts.task;

    // Reject --device on every later verb, including `stop --profile`.
    if (deviceFlag) {
      console.error(REJECT_DEVICE_MESSAGE);
      process.exit(1);
    }

    if (top === 'stop' && opts.profile && !taskFlag) return;
    // `stop --service` names no task; resolving one refused it whenever this
    // session had more than one bound task ("pass --task"), which --service rejects.
    if (top === 'stop' && (opts.service || opts.daemon) && !taskFlag) return;

    // A profile only a peer declares runs on that peer, whose daemon checks its
    // own consent. For a cold profile-scoped page verb, create the task on the
    // owner first and bind that owner locally; the ordinary task router below
    // then forwards this complete verb and every subsequent verb to that host.
    if (!taskFlag && opts.profile) {
      try {
        const profileName = (await resolveProfileRef(opts.profile)) ?? opts.profile;
        const target = resolveBrowserTarget(profileName);
        if (!target.local) {
          console.error(target.picked);
          const started = await dispatchBrowserToDevice(
            target.device,
            ['browser', 'start', '--profile', profileName, '--json'],
            'capture',
          );
          if (started.code !== 0) {
            process.stdout.write(started.stdout);
            process.stderr.write(started.stderr);
            process.exit(started.code);
          }
          const task = remoteStartTaskName(started.stdout);
          if (!task) throw new Error(`Remote start on ${target.device} produced no task name.`);
          bindTask(task, {
            device: target.device,
            profile: profileName,
            sessionId: resolveCallerIdentity().sessionId,
            launchId: resolveCallerIdentity().launchId,
            createdAt: Date.now(),
          });
          inferredTaskName = task;
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    const verbProfile = !opts.profile || opts.profile === 'default' ? opts.profile : ((await resolveProfileRef(opts.profile)) ?? opts.profile);
    const route = resolveTaskRoute({
      task: inferredTaskName ?? taskFlag ?? process.env.AGENTS_BROWSER_TASK,
      sessionId: resolveCallerIdentity().sessionId,
      launchId: resolveCallerIdentity().launchId,
      // A cold verb naming a profile this box declares stays here, as `start` does.
      hub: startForwardTarget({
        hub: defaultBrowserHub(),
        profile: verbProfile,
        declaring: verbProfile ? declaringDevices(verbProfile) : [],
        self: machineId(),
      }),
    });
    if (route.kind !== 'proceed') {
      console.error(route.message);
      process.exit(1);
    }

    inferredTaskName = route.task;
    // Forward cold page verbs to their routed hub so it creates the caller's task; only self-host
    // routes run locally.
    if (isSelfHost(route.device)) return;
    // ...but a cold CLOSE verb (done/stop) must NOT forward: with no task it
    // would target a browsing context this session never opened. It stays local
    // (its historic no-task behaviour) unless an explicit --task/local binding
    // routes it — a taskless `done` must never blindly stop a hub task.
    if (!route.task && isTerminalBrowserVerb(top)) return;

    const outputPath = top === 'screenshot' ? opts.output : undefined;
    // The far side gets no stdin, so a piped script travels as the expression.
    const stdinScript = top === 'evaluate' && (opts as { file?: string }).file === '-' ? readStdinScript() : undefined;
    const forwarded = browserForwardedArgv(
      actionCommand,
      [...(outputPath ? ['output'] : []), ...(stdinScript !== undefined ? ['file'] : [])],
      [...(route.task && !taskFlag ? ['--task', route.task] : []), ...(stdinScript !== undefined ? ['-e', stdinScript] : [])],
    );

    if (outputPath) {
      const captured = await dispatchBrowserToDevice(route.device, forwarded, 'capture');
      if (captured.code !== 0) {
        process.stderr.write(captured.stderr);
        process.exit(captured.code);
      }
      const remotePath = captured.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (!remotePath) {
        console.error(`Remote screenshot on ${route.device} produced no path.`);
        process.exit(1);
      }
      try {
        await pullRemoteFile(route.device, remotePath, outputPath);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      const saved = path.resolve(outputPath);
      console.log(saved);
      process.exit(0);
    }

    const result = await dispatchBrowserToDevice(route.device, forwarded, 'stream');
    if (result.code === 0 && (top === 'done' || top === 'stop') && route.task) {
      unbindTask(route.task);
    }
    process.exit(result.code);
  });

  browser
    .command('remote-control [state]')
    .description(
      "Allow or deny other machines driving THIS machine's browser (`browser start --device <this-device>` or `agents ssh <this-device> browser …`). " +
        '`on`/`off` to set (device-local, never synced); no argument prints the current value. Default off.',
    )
    .option('--json', 'Output as JSON')
    .action((state: string | undefined, opts: { json?: boolean }) => {
      const KEY = 'browser.remote-control';
      if (state === undefined) {
        const cur = getConfigValue(KEY).value === true;
        if (opts.json) {
          console.log(JSON.stringify({ remoteControl: cur }));
          return;
        }
        console.log(`Remote browser control (this machine): ${cur ? 'on' : 'off'}`);
        if (!cur) console.log('Enable with: browser remote-control on');
        return;
      }
      const norm = state.toLowerCase();
      const onWords = ['on', 'true', 'yes', 'allow', 'enable'];
      const offWords = ['off', 'false', 'no', 'deny', 'disable'];
      if (!onWords.includes(norm) && !offWords.includes(norm)) {
        console.error(`Expected "on" or "off", got "${state}".`);
        process.exit(1);
      }
      const value = onWords.includes(norm);
      setConfigValue(KEY, value);
      if (opts.json) {
        console.log(JSON.stringify({ remoteControl: value }));
        return;
      }
      console.log(`Remote browser control (this machine) is now ${value ? 'on' : 'off'}.`);
      console.log(
        value
          ? 'Other fleet machines can now drive this browser via `browser start --device <this-device>` or `agents ssh <this-device> browser …`.'
          : 'Cross-machine drives of this browser (`browser start --device`, `agents ssh … browser …`) are refused.',
      );
    });

  const stream = browser
    .command('stream')
    .description('Keep one process and daemon IPC socket open; read NDJSON requests from stdin and write NDJSON responses')
    .option(TASK_OPTION_FLAG, 'Default task for requests that omit `task` (defaults to $AGENTS_BROWSER_TASK)')
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts: { task?: string; device?: string }) => {
      await runBrowserIPCStream({
        input: process.stdin,
        output: process.stdout,
        task: opts.task ?? process.env.AGENTS_BROWSER_TASK,
        ...resolveCallerIdentity(),
      });
    });

  setHelpSections(stream, {
    examples: `
      # Batch two warm actions through one process and one browser-service connection
      printf '%s\\n' \\
        '{"action":"screenshot","path":"/tmp/page.jpg"}' \\
        '{"action":"click","atX":320,"atY":540}' \\
        | browser stream --task "$AGENTS_BROWSER_TASK"

      # Keep the command open and send one JSON object per line from a long-lived shell
      browser stream --task "$AGENTS_BROWSER_TASK"
    `,
    notes: `
      stdout is protocol-only: one compact JSON response for each non-empty input line.
      Malformed JSON returns an error response without closing the stream.
      The first start response becomes the default task for later lines in the same stream.
    `,
  });

  browser
    .command('start')
    .description('Start a browser task. Pass --profile <name>; omit to use your configured default (set it with `browser use <name>`). Page verbs (navigate/screenshot/…) create a task implicitly when none exists — start is for --profile/--url/--record/--title.')
    .option('-p, --profile <name>', 'Browser profile to use (omit to use this machine\'s configured default; set it with `browser use <name>`)')
    .option(TASK_OPTION_FLAG, 'Task name (auto-generated short id if omitted)')
    .option('--title <label>', 'Human label shown in `browser status` (defaults to first navigated host)')
    .option('-e, --endpoint <name>', 'Endpoint preset (defaults to the profile\'s default)')
    .option('-u, --url <url>', 'Open URL in first tab')
    .option('--device <name>', 'Device that hosts this task (defaults to the browser.device hub when set; use `local` to force this machine). Later verbs resolve it from --task; not valid on page verbs')
    .option('--fresh', 'Always open a new tab, skipping the reclaim of a tab an abandoned task is holding on that URL')
    .option('--no-skills', 'Do not print the site guide for --url (from the browser skill: `browser skills list`)')
    .option('--record', 'Start recording right after the tab opens (shorthand for `browser record start` as a follow-up)')
    .option('--fps <n>', 'Recording frames per second (with --record; 1–30, default 5)', intOption)
    .option('--duration <sec>', 'Recording duration cap in seconds (with --record; default 60)', intOption)
    .option('--max-mb <mb>', 'Recording size cap in MB (with --record; default 25)', intOption)
    .option(SNAPSHOT_OPTION_FLAG, 'Once --url has loaded, also print its url, title and interactive refs after the task name, so the first action needs no `browser refs`')
    .option('--json', 'Output machine-readable JSON (task handle + tabId + reused/message)')
    .action(async (opts, command: Command) => {
      // Fast-fail before profile resolution; the authoritative daemon gate also covers implicit
      // page-verb creation.
      try {
        assertRemoteControlAllowed();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Forward hub starts before local validation; the hub owns its profiles and consent, and later
      // verbs follow the task index.
      if (!opts.device) {
        const startProfile = !opts.profile || opts.profile === 'default' ? opts.profile : ((await resolveProfileRef(opts.profile)) ?? opts.profile);
        const hub = startForwardTarget({
          hub: defaultBrowserHub(),
          profile: startProfile,
          declaring: startProfile ? declaringDevices(startProfile) : [],
          self: machineId(),
        });
        if (hub) {
          // Let the hub validate its own profiles and return its exit code; local declarations may not
          // include them.
          try {
            const result = await dispatchBrowserToDevice(hub, browserForwardedArgv(command), 'capture');
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.code !== 0) process.exit(result.code);
            const taskName = remoteStartTaskName(result.stdout, opts.task);
            if (!taskName) {
              console.error(`Remote start on ${hub} produced no task name.`);
              process.exit(1);
            }
            bindTask(taskName, {
              device: hub,
              // Only what the caller named; the hub's own default (bare start) is
              // opaque here. Name-based `done`/`stop --task` and the post-stop
              // unbind GC these regardless.
              profile: opts.profile,
              url: opts.url,
              sessionId: resolveCallerIdentity().sessionId,
              launchId: resolveCallerIdentity().launchId,
              createdAt: Date.now(),
            });
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
          return;
        }
      }

      // Route explicit devices before resolving browsers/profiles; only the target can validate its
      // installed browser and default.
      const deviceName: string | undefined =
        opts.device === 'local' || opts.device === 'self' ? undefined : opts.device;
      if (deviceName) {
        const lowered = deviceName.toLowerCase();
        if (lowered === 'all' || lowered === 'auto') {
          console.error(
            `--device ${deviceName} is not valid on \`browser start\`: a task lives on one device.\n` +
              `Next: browser start --task <name> --device <device>`,
          );
          process.exit(1);
        }
        if (!isSelfHost(deviceName) && !isFleetRemoteInvocation()) {
          // Resolve only explicitly named profiles; a bare remote start must use the target's default,
          // never this box's.
          const forwardProfile = opts.profile ? await resolveProfileRef(opts.profile) : undefined;
          // A relay device has no entry in this box's registry; it validates its own profiles.
          if (forwardProfile && !relayFromEnv()) {
            try {
              assertDeviceDeclaresProfile(deviceName, forwardProfile);
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exit(1);
            }
          }
          try {
            const result = await dispatchBrowserToDevice(deviceName, browserForwardedArgv(command), 'capture');
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.code !== 0) process.exit(result.code);
            const taskName = remoteStartTaskName(result.stdout, opts.task);
            if (!taskName) {
              console.error(`Remote start on ${deviceName} produced no task name.`);
              process.exit(1);
            }
            bindTask(taskName, {
              device: deviceName,
              // Only the caller-named profile; the target's own default (bare
              // start) is opaque here, exactly as in the hub path.
              profile: forwardProfile ?? opts.profile,
              url: opts.url,
              sessionId: resolveCallerIdentity().sessionId,
              launchId: resolveCallerIdentity().launchId,
              createdAt: Date.now(),
            });
            if (!result.stderr.includes(`started on ${deviceName}`)) {
              console.error(`Task "${taskName}" started on ${deviceName}.`);
            }
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
          return;
        }
      }

      // Start validates local launchability after common name resolution; filter-only commands must
      // not warn about default config.
      let profileName: string;
      try {
        profileName = await resolveProfileRefForStart(opts.profile);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Pre-check the profile locally so we fail fast with a helpful error
      // instead of round-tripping a generic "Profile not found" through the daemon.
      const profile = await getProfile(profileName);
      if (!profile) {
        console.error(`Profile "${profileName}" not found.`);
        const all = await listProfiles();
        if (all.length > 0) {
          console.error(`Available profiles: ${all.map((p) => p.name).join(', ')}`);
        }
        console.error(
          `Create one with: browser profiles create ${profileName} --browser <chrome|comet|chromium|brave|edge|arc|custom>`
        );
        process.exit(1);
      }

      // Discovery is read-only for list/show/doctor. Starting is the explicit
      // adoption point: persist only the agents-cli alias/native identity, never
      // mutate Arc's own profile or Space data.
      await persistDiscoveredProfile(profileName);

      // A profile only a peer declares runs on that peer, exactly as `--device`
      // would, so the peer's daemon checks its own consent. Bind the returned
      // task locally so every later verb follows the same owner from task-index.
      if (!isFleetRemoteInvocation()) {
        let routed;
        try {
          routed = resolveBrowserTarget(profileName, { endpointName: opts.endpoint });
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        if (!routed.local) {
          console.error(routed.picked);
          const result = await dispatchBrowserToDevice(routed.device, browserForwardedArgv(command), 'capture');
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          if (result.code !== 0) process.exit(result.code);
          const taskName = remoteStartTaskName(result.stdout, opts.task);
          if (!taskName) {
            console.error(`Remote start on ${routed.device} produced no task name.`);
            process.exit(1);
          }
          bindTask(taskName, {
            device: routed.device,
            profile: profileName,
            url: opts.url,
            sessionId: resolveCallerIdentity().sessionId,
            launchId: resolveCallerIdentity().launchId,
            createdAt: Date.now(),
          });
          return;
        }
      }

      // Pre-check the endpoint name too — same fail-fast rationale.
      if (opts.endpoint) {
        const presets = getEndpointPresets(profile);
        if (!presets[opts.endpoint]) {
          console.error(
            `Endpoint "${opts.endpoint}" not found on profile "${profileName}". ` +
              `Available: ${Object.keys(presets).join(', ')}`
          );
          process.exit(1);
        }
      }

      // Only local/self launches reach here; verify this device declares the locally resolved profile.
      if (deviceName) {
        try {
          assertDeviceDeclaresProfile(deviceName, profileName);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }

      // Grounded login guardrail: if the opening URL is a known login-gated
      // service and the resolved profile has no session for it, say so on stderr
      // and name a profile that IS logged in. Reads the profile's real cookie DB
      // (presence only) — never blocks or slows start; any failure is silent.
      if (opts.url) {
        try {
          const service = serviceForUrl(opts.url);
          if (service) {
            // An unread store says nothing either way, so it never warns.
            const here = await loginsWithAccountsForProfile(profile, opts.endpoint);
            if (!here.unread && !here.logins.some((login) => login.service === service)) {
              const elsewhere = (await profilesLoggedInto(service)).filter((p) => p !== profileName);
              const hint = elsewhere.length
                ? `logged in elsewhere: ${elsewhere.join(', ')}. try: --profile ${elsewhere[0]}`
                : `no profile on this machine has a ${service} session.`;
              console.error(`warning: profile "${profileName}" (${profile.browser}) has no ${service} session. ${hint}`);
            }
          }
        } catch { /* login detection is best-effort; never block start */ }
      }

      // Identity is stamped inside sendIPCRequest; no need to pass it here.
      const response = await sendIPCRequest({
        action: 'start',
        profile: profileName,
        taskName: opts.task,
        url: opts.url,
        endpoint: opts.endpoint,
        fresh: opts.fresh === true,
        title: opts.title,
        snapshot: opts.snapshot === true,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const boundDevice = deviceName && isSelfHost(deviceName) ? deviceName : machineId();
      if (response.task) {
        bindTask(response.task, {
          device: boundDevice,
          profile: profileName,
          url: opts.url,
          sessionId: resolveCallerIdentity().sessionId,
          launchId: resolveCallerIdentity().launchId,
          createdAt: Date.now(),
        });
      }

      // The site guide for --url's host, read from this binary's own skill
      // (skills/browser/references/sites/). A missing skill is reported, not
      // treated as "no guide": the task has already started either way.
      let siteGuide: SiteGuide | null = null;
      if (opts.url && opts.skills !== false) {
        try {
          siteGuide = resolveSiteGuide(opts.url);
        } catch (err) {
          if (!(err instanceof BrowserSkillsUnavailableError)) throw err;
          console.error(`warning: site guides unavailable: ${err.message}`);
        }
      }

      // --json: machine-readable, still task-handle-first for callers that parse it.
      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          device: boundDevice,
          profile: profileName,
          // `reused` is task-level; `created`/`refreshed` describe the page op.
          reused: response.reused === true,
          created: response.created,
          refreshed: response.refreshed,
          message: response.message,
          siteGuide: siteGuide ? { name: siteGuide.name, path: siteGuide.path } : undefined,
          snapshot: response.snapshot,
        }, null, 2));
        return;
      }

      // stdout: the resolved name on the first line, no decoration. Lets callers do:
      //   export AGENTS_BROWSER_TASK=$(browser start --profile work)
      // --snapshot adds the page listing after it; the name stays the first line.
      console.log(response.task);
      printSnapshot(response.snapshot);

      // stderr: human-friendly commentary so a TTY user still sees what happened.
      // Shell substitution captures stdout only, so $(...) stays clean. A same-name
      // retry reused the TASK — key on `reused`, not the page-level `refreshed`
      // (a no-URL retry reuses the task without reloading anything).
      const startVerb = response.reused ? 'reused' : 'started';
      console.error(`Task "${response.task}" ${startVerb} on ${boundDevice} (profile: ${profileName}).`);
      if (response.message) console.error(response.message);
      if (opts.url && response.tabId) {
        console.error(`Tab ${response.tabId}`);
      }
      console.error('Tip: later page verbs from this shell session drive this task; --device is only valid on start.');
      console.error('Try: browser screenshot | browser console --level error');

      // Print the site guide so the agent reads the site's selectors and
      // gotchas before it starts clicking. The markers let a parser extract it.
      if (siteGuide) {
        console.error('');
        console.error(`--- site guide: ${siteGuide.name} (${siteGuide.hostname}) ---`);
        console.error(siteGuide.content);
        console.error(`--- end site guide: ${siteGuide.name} ---`);
      }

      // --record convenience: fire record-start right after the tab opens so
      // the user gets a single-command capture flow. Failures here are
      // reported but don't fail the start — the task is already running.
      if (opts.record) {
        const recordResponse = await sendIPCRequest({
          action: 'record-start',
          task: response.task,
          tabId: response.tabId,
          fps: opts.fps,
          duration: opts.duration,
          maxMb: opts.maxMb,
        });
        if (!recordResponse.ok) {
          console.error(`Recording failed to start: ${recordResponse.error}`);
        } else {
          console.error(
            `Recording at ${recordResponse.fps} fps (cap ${recordResponse.durationCapSec}s / ${recordResponse.maxMb} MB) -> ${recordResponse.path}`
          );
          console.error('Stop with: browser record stop');
        }
      }
    });

  browser
    .command('done')
    .description('Complete a task and close its tabs (resolves from caller identity when --task is omitted)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'done',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (response.message === 'nothing to close' || !response.task) {
        console.log('nothing to close');
        return;
      }
      console.log(`Completed task: ${response.task}`);
    });

  browser
    .command('stop')
    .description('Stop a browser task and close its tabs; with --profile, detach the whole profile; with --service, stop the browser IPC service')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-p, --profile <name>', 'Detach the whole profile (incl. composite "name@endpoint") instead of stopping a single task')
    .option('--service', 'Stop the browser IPC service and clear a stale/wedged socket')
    .addOption(new Option('--daemon').hideHelp())
    .action(async (opts) => {
      if (opts.service || opts.daemon) {
        if (opts.profile || opts.task) {
          console.error('--service stops browser IPC; do not combine it with --profile or --task.');
          process.exit(1);
        }
        if (opts.daemon) {
          console.error('`--daemon` means the browser service only; use `--service`.');
        }
        try {
          const result = await stopBrowserService();
          const parts: string[] = [];
          parts.push(result.wasRunning ? 'Stopped browser service' : 'Browser service was not running');
          if (result.socketCleared) parts.push('cleared stale socket');
          console.log(`${parts.join('; ')}. Browser IPC starts again on the next browser action that requires it.`);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
        return;
      }

      if (opts.profile) {
        const profile = (await resolveProfileRef(opts.profile)) ?? opts.profile;
        const response = await sendIPCRequest({
          action: 'stop',
          profile,
        });
        if (!response.ok) {
          console.error(response.error);
          process.exit(1);
        }
        console.log(`Stopped profile: ${profile}`);
        return;
      }

      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'stop',
        task,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (response.message === 'nothing to close' || !response.task) {
        console.log('nothing to close');
        return;
      }
      console.log(`Stopped task: ${response.task}`);
    });

  browser
    .command('prune')
    .alias('gc')
    .description(
      'Close tabs for abandoned tasks — owning agent session exited, or idle past the window — and mark them done. ' +
        'The same reaper the daemon already runs every 5 minutes; use this to run it now.'
    )
    .option('--dry-run', 'List what would be closed without closing anything')
    .option(
      '--idle-minutes <n>',
      'Override the idle window in minutes (default: this device\'s browser.task-idle-minutes, or 30). ' +
        '0 disables idle-only closing for this run; session-dead tasks are still closed.',
      intOption
    )
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'gc',
        dryRun: opts.dryRun,
        idleMinutes: opts.idleMinutes,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const reaped = response.reaped ?? { closed: [], skipped: 0, failed: [] };
      if (reaped.failed.length > 0) process.exitCode = 1;
      if (opts.json) {
        console.log(JSON.stringify(reaped, null, 2));
        return;
      }

      if (reaped.closed.length === 0 && reaped.failed.length === 0) {
        console.log(`No abandoned tasks${opts.dryRun ? ' (dry run)' : ''}; ${reaped.skipped} task(s) still active.`);
        return;
      }

      const verb = opts.dryRun ? 'Would close' : 'Closed';
      console.log(`${verb} ${reaped.closed.length} task(s), left ${reaped.skipped} alone:`);
      for (const c of reaped.closed) {
        console.log(`  ${c.task}  (${c.profile}, ${c.reason})`);
      }
      if (reaped.failed.length > 0) {
        console.log(`Could not close ${reaped.failed.length} task(s):`);
        for (const f of reaped.failed) {
          console.log(`  ${f.task}  (${f.profile}): ${f.error}`);
        }
      }
    });

  browser
    .command('show <url>')
    .description('Open a URL or file for a human to read in browser.viewer (default: browser.profile), on the browser.device hub when one is set; reloads and focuses a tab already showing it; fails unless the viewer confirms it opened. Binds no task')
    .option('-p, --profile <name>', 'Show it in this profile instead of browser.viewer')
    .option('--os-browser', 'Use the OS default handler instead of the configured viewer')
    .option('--fresh', 'Always open a new tab, even when one already shows this page (default: navigate and focus that tab)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (url: string, opts: { profile?: string; osBrowser?: boolean; fresh?: boolean; json?: boolean }) => {
      // The entry point external tools need. `navigate` binds a task, which the
      // abandoned-task reaper closes when the calling session ends — wrong for a
      // page a person is reading. This does not.
      const { showUrl, showFile } = await import('../runtime/open-url.js');
      // `+` not `*` on the scheme body: `[a-z][a-z0-9+.-]*:` matches a Windows
      // drive letter (`C:\Users\me\plan.html`), so a real path was treated as a
      // URL. A scheme is at least two characters.
      const isLocalFile = !/^[a-z][a-z0-9+.-]+:/i.test(url);
      const showOpts = { profile: opts.profile, osBrowser: opts.osBrowser, fresh: opts.fresh };
      const profile = !opts.profile || opts.profile === 'default' ? opts.profile : ((await resolveProfileRef(opts.profile)) ?? opts.profile);
      const hub = startForwardTarget({
        hub: defaultBrowserHub(),
        profile,
        declaring: profile ? declaringDevices(profile) : [],
        self: machineId(),
      });
      let outcome: ShowOutcome & { device?: string };
      if (hub) {
        outcome = await showOnHub(hub, url, isLocalFile, opts);
      } else {
        outcome = isLocalFile ? await showFile(path.resolve(url), showOpts) : await showUrl(url, showOpts);
      }

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
      } else if (outcome.via === 'none') {
        const where = `${outcome.profile ? ` in ${outcome.profile}` : ''}${outcome.device ? ` on ${outcome.device}` : ''}`;
        console.error(`Could not show it${where}${outcome.reason ? `: ${outcome.reason}` : ''}\nOpen this yourself:\n  ${url}`);
      } else if (outcome.via === 'profile') {
        console.log(`${outcome.reused ? 'Showed it in the tab already open' : 'Shown'} in ${outcome.profile}${outcome.device ? ` on ${outcome.device}` : ''}: ${url}`);
      } else {
        console.log(`Opened in the OS default browser${outcome.device ? ` on ${outcome.device}` : ''}: ${url}`);
      }
      if (outcome.via === 'none') process.exit(1);
    });

  browser
    .command('navigate [url]')
    .alias('goto')
    .description('Navigate current tab to URL (creates a task and tab when none exist)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-u, --url <url>', 'URL to navigate to (or pass it positionally)')
    .option('-p, --profile <name>', 'Browser profile (optional if task is unique)')
    .option(SNAPSHOT_OPTION_FLAG, SNAPSHOT_OPTION_DESC)
    .addOption(waitOption())
    .option(NO_WAIT_OPTION_FLAG, NO_WAIT_OPTION_DESC)
    .option('--json', 'Output machine-readable JSON')
    .action(async (urlPos: string | undefined, opts: { task?: string; url?: string; profile?: string; json?: boolean; snapshot?: boolean; wait?: boolean }) => {
      const url = urlPos || opts.url;
      if (!url) {
        console.error('URL required. Usage: browser navigate <url>');
        process.exit(1);
      }
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'navigate',
        task,
        url,
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
        snapshot: opts.snapshot,
        wait: opts.wait,
      });

      if (!response.ok) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: response.error }));
        else console.error(response.error);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          url,
          created: response.created ?? false,
          refreshed: response.refreshed ?? false,
          message: response.message,
          ...(response.snapshot ? { snapshot: response.snapshot } : {}),
        }, null, 2));
        return;
      }

      if (response.task) {
        console.error(`task ${response.task}`);
      }
      // Honest human output: a same-task reopen reloaded the SAME tab rather than
      // navigating a fresh one. Any picked-device / reopen note rides
      // stderr so stdout stays the one-line result.
      if (response.message) console.error(response.message);
      const verb = response.refreshed ? 'Refreshed' : 'Navigated';
      console.log(`${verb} ${response.tabId} to ${url}`);
      printSnapshot(response.snapshot);
    });

  // Tab subcommand group
  const tab = browser.command('tab').description('Manage tabs');

  tab
    .command('add')
    .description('Open URL in new tab (becomes current)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .requiredOption('--url <url>', 'URL to open in the new tab')
    .option('-p, --profile <name>', 'Browser profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-add',
        task,
        url: opts.url,
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
      });

      if (!response.ok) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: response.error }));
        else console.error(response.error);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          task: response.task,
          tabId: response.tabId,
          url: opts.url,
          created: response.created ?? false,
          refreshed: response.refreshed ?? false,
          message: response.message,
        }, null, 2));
        return;
      }

      // A reopen of a URL already in an owned tab refreshes that tab in place
      // rather than opening a duplicate.
      if (response.refreshed) {
        if (response.message) console.error(response.message);
        console.log(`Refreshed tab ${response.tabId}: ${opts.url}`);
      } else {
        console.log(`Opened tab ${response.tabId}: ${opts.url}`);
      }
    });

  tab
    .command('focus <tabId>')
    .description('Switch to tab (by ID, prefix, or URL substring)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (tabId: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-focus',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Focused tab ${response.tabId}`);
    });

  tab
    .command('close [tabId]')
    .description('Close tab(s) — omit tabId to close all')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (tabId: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-close',
        task,
        tabId,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(tabId ? `Closed tab ${tabId}` : `Closed all tabs for ${task}`);
    });

  browser
    .command('tabs')
    .description('List tabs open for the current task; --all shows every tab open in the profile browser, yours included')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--all', "Every tab open in the profile browser, not only this task's: OWNER names the owning task, or \"you\" for a tab no task owns")
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'tab-list',
        task,
        ...(opts.all ? { all: true } : {}),
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.tabs ?? [], null, 2));
        return;
      }

      if (!response.tabs || response.tabs.length === 0) {
        console.log('No tabs open');
        return;
      }

      if (opts.all) {
        console.log('TAB'.padEnd(12) + 'OWNER'.padEnd(18) + 'URL');
        console.log('-'.repeat(88));
        for (const t of response.tabs) {
          const owner = t.task ?? 'you';
          const current = t.current ? ' *' : '';
          console.log(t.id.slice(0, 11).padEnd(12) + owner.slice(0, 17).padEnd(18) + t.url.slice(0, 55) + current);
        }
        return;
      }
      console.log('TAB'.padEnd(12) + 'URL');
      console.log('-'.repeat(70));
      for (const t of response.tabs) {
        const current = (t as { id: string; url: string; current?: boolean }).current ? ' *' : '';
        console.log(t.id.padEnd(12) + t.url.slice(0, 55) + current);
      }
    });


  browser
    .command('screenshot')
    .description('Take a screenshot — auto-saved per task; --output only needed when you want a specific path')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-o, --output <path>', 'Specific output path (otherwise auto-saved under sessions/<task>/)')
    .option(
      '-q, --quality <mode>',
      'compressed (JPEG, capped at ~100 KB — default) or raw (PNG, pixel-faithful)',
      'compressed'
    )
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.quality !== 'compressed' && opts.quality !== 'raw') {
        console.error('--quality must be "compressed" or "raw"');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'screenshot',
        task,
        tabId: opts.tab,
        path: opts.output,
        quality: opts.quality,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // The daemon sandboxes writes to the runtime dir and silently
      // ignores `-o` outside it. Honor the requested path here.
      const savedPath = response.path
        ? honorScreenshotOutput(opts.output, response.path)
        : response.path;

      // stdout: just the path, so `P=$(browser screenshot)` works.
      console.log(savedPath);

      // stderr: human commentary with size + dimensions, so an agent can
      // see at a glance what was captured without `ls -l && file` round-trips.
      const size = humanizeBytes(response.bytes);
      const dims = response.width && response.height ? `${response.width}×${response.height}` : 'unknown size';
      console.error(`Saved screenshot to ${savedPath} (${size}, ${dims})`);

      // When auto-saving (no --output), surface the directory once so the
      // agent doesn't have to dirname() the path or guess where files land.
      if (!opts.output && savedPath) {
        const dir = path.dirname(savedPath);
        console.error(`Tip: auto-saving to ${dir}. Pass --output <path> to choose a path.`);
      }
    });

  browser
    .command('pdf [output]')
    .description('Export the current tab as PDF via CDP Page.printToPDF — auto-saved under sessions/<task>/ when [output] is omitted')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (output: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'pdf',
        task,
        tabId: opts.tab,
        path: output,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.path);
      const size = humanizeBytes(response.bytes);
      console.error(`Saved PDF to ${response.path} (${size})`);

      if (!output && response.path) {
        const dir = path.dirname(response.path);
        console.error(`Tip: auto-saving to ${dir}. Pass a path argument to choose one.`);
      }
    });

  browser
    .command('text')
    .description("Print the tab's title and URL, then the text a reader sees on the page and, in Chromium-family browsers, inside its iframes")
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--css <selector>', 'The text of each element the CSS selector matches in the top document (not iframes), blocks separated by --, instead of the whole page')
    .option('--attr <name>', 'With --css, each match\'s attribute instead of its text (href and src come back absolute)')
    .option('--grep <pattern>', 'Only the lines that match (a case-insensitive regular expression), after the title line')
    .option('--context <n>', 'Lines kept around each --grep match (default 2)', intOption)
    .action(async (opts: { task?: string; tab?: string; device?: string; grep?: string; context?: number; css?: string; attr?: string }) => {
      if (opts.attr !== undefined && opts.css === undefined) {
        console.error('--attr reads an attribute of each --css match; pass --css <selector> too.');
        process.exit(1);
      }
      const context = opts.context ?? 2;
      if (context < 0) {
        console.error(`--context must be a whole number, got: ${opts.context}`);
        process.exit(1);
      }
      const response = await sendIPCRequest({ action: 'text', task: resolveTaskName(opts), tabId: opts.tab, css: opts.css, attr: opts.attr });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      // printLine writes all of it: a console.log over 64 KiB to a pipe keeps only the start (AGENTS.md).
      const text = String(response.result ?? '');
      if (opts.grep === undefined) {
        printLine(text);
        return;
      }
      const [title, ...body] = text.split('\n');
      const { lines, matched } = grepText(body.join('\n'), opts.grep, context);
      printLine(title);
      // A miss is an answer, not a failure: exiting 1 ended the agent's `&&` chain and cost a turn.
      if (!matched) {
        console.error(`No line matches "${opts.grep}".`);
        return;
      }
      printLine(lines.join('\n'));
    });

  browser
    .command('evaluate [expression]')
    .alias('eval')
    .description('Evaluate JavaScript in current tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-e, --expression <js>', 'JavaScript expression to evaluate (or pass it positionally)')
    .option('-f, --file <path>', 'Path to a .js file whose contents will be evaluated (`-` reads stdin)')
    .action(async (exprPos: string | undefined, opts: { task?: string; tab?: string; expression?: string; file?: string }) => {
      const task = resolveTaskName(opts);
      const flagExpr = opts.expression || exprPos;
      if (flagExpr && opts.file) {
        console.error('Pass exactly one of an expression or --file');
        process.exit(1);
      }
      let expression: string;
      if (opts.file === '-') {
        expression = readStdinScript();
      } else if (opts.file) {
        try {
          expression = fs.readFileSync(opts.file, 'utf8');
        } catch (err) {
          console.error(`Cannot read --file ${opts.file}: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (flagExpr) {
        expression = flagExpr;
      } else {
        console.error('Pass an expression positionally, -e <js>, --file <path>, or --file - for a script on stdin');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'evaluate',
        task,
        tabId: opts.tab,
        expr: expression,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(JSON.stringify(response.result, null, 2));
    });

  browser
    .command('ps')
    .description('List every browser/electron/tunnel process the service has tracked (alive or stale) — works without the daemon')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      const snapshots = listAllProfileSnapshots();
      // Cross-check against what's actually listening locally so we can
      // surface "port claimed by us but nothing is listening" (= leaked
      // cache file) and "port listening but not in our records" (= someone
      // else owns it; a new profile pointing here would collide).
      const portOwners = new Map<number, { pid: number; command: string }>();
      const conflicts: string[] = [];
      for (const s of snapshots) {
        const port = s.meta?.port;
        if (!port) continue;
        const occupant = getPortOccupant(port);
        if (!occupant) {
          if (s.pidAlive || s.tunnelAlive) {
            conflicts.push(`${s.name}: port ${port} marked active but nothing is listening`);
          }
          continue;
        }
        const ourPid = s.meta?.tunnelPid && s.meta.kind === 'tunnel'
          ? s.meta.tunnelPid
          : s.meta?.pid;
        if (ourPid && occupant.pid !== ourPid) {
          conflicts.push(
            `${s.name}: port ${port} listened on by ${occupant.command} (pid ${occupant.pid}) but our record says pid ${ourPid}`
          );
        }
        portOwners.set(port, occupant);
      }

      if (opts.json) {
        console.log(JSON.stringify({ snapshots, conflicts }, null, 2));
        return;
      }

      if (snapshots.length === 0) {
        console.log('No tracked browser state. Run `browser start --profile <name>` to spawn one.');
        return;
      }

      console.log('PROFILE                                  KIND      PID    TUNNEL  PORT   ALIVE  TASKS  OWNER');
      console.log('-----------------------------------------------------------------------------------------------');
      for (const s of snapshots) {
        const kind = s.meta?.kind ?? '-';
        const pid = s.meta?.pid ?? '-';
        const tunnelPid = s.meta?.tunnelPid ?? '-';
        const port = s.meta?.port ?? '-';
        const alive = aliveLabel(s);
        const owner = s.meta?.daemonPid
          ? `daemon${s.daemonAlive ? '' : '(dead)'}=${s.meta.daemonPid}`
          : '-';
        console.log(
          `${s.name.padEnd(40)} ${String(kind).padEnd(9)} ${String(pid).padEnd(6)} ${String(tunnelPid).padEnd(7)} ${String(port).padEnd(6)} ${alive.padEnd(6)} ${String(s.taskCount).padEnd(6)} ${owner}`
        );
      }

      if (conflicts.length > 0) {
        console.log('');
        console.log('Conflicts / leaks detected:');
        for (const c of conflicts) console.log(`  - ${c}`);
        console.log('');
        console.log('Run `browser stop --profile <name>` to clean up a specific profile, or restart the daemon to trigger the orphan reaper.');
      }
    });

  function aliveLabel(s: { pidAlive: boolean; tunnelAlive: boolean; meta: { kind?: string } | null }): string {
    const k = s.meta?.kind;
    if (k === 'tunnel') return s.tunnelAlive ? 'yes' : 'stale';
    return s.pidAlive ? 'yes' : 'stale';
  }

  browser
    .command('status')
    .description('Show browser service state and running browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      let response;
      try {
        response = await sendIPCRequest({
          action: 'status',
          profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
        }, { autoStartDaemon: false, timeoutMs: 3_000 });
      } catch (err) {
        if (err instanceof BrowserServiceNotRunningError) {
          const message = formatBrowserServiceNotRunningError();
          if (opts.json) {
            console.log(JSON.stringify({ running: false, ok: false, service: { id: 'browser-ipc', state: 'stopped' }, error: message }));
          } else {
            console.error(message);
          }
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, service: { id: 'browser-ipc', state: 'unknown' }, error: err instanceof Error ? err.message : String(err) }));
          process.exit(1);
        }
        throw err;
      }

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ running: true, profiles: response.profiles ?? [] }, null, 2));
        return;
      }

      console.log(chalk.gray('Browser service: running'));

      // Build flat list of tasks with profile context
      const allTasks: BrowserTask[] = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({ task, profile });
        }
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 }, { autoStartDaemon: false, timeoutMs: 3_000 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
          console.log('\nRun `browser history` for more.');
        } else {
          console.log('No browser tasks running');
        }
        return;
      }

      // Interactive picker for TTY, plain output otherwise
      if (isInteractiveTerminal()) {
        const picked = await browserTaskPicker({
          message: 'Browser tasks:',
          tasks: allTasks,
        });
        if (picked) {
          // Show tab list for the selected task
          const tabResponse = await sendIPCRequest({
            action: 'tab-list',
            task: picked.task.task.name,
          });
          if (tabResponse.ok && tabResponse.tabs) {
            console.log(`\nTabs for ${picked.task.task.name}:`);
            for (const tab of tabResponse.tabs) {
              console.log(`  ${tab.id}  ${tab.url}`);
            }
          }
        }
      } else {
        // Non-interactive: simple table output
        for (const profile of response.profiles || []) {
          const portLabel =
            profile.configuredPort && profile.configuredPort !== profile.port
              ? `port ${profile.port} (configured ${profile.configuredPort})`
              : `port ${profile.port}`;
          // pid 0 means the daemon attached to a browser we didn't launch — no
          // tracked pid. Render it as "attached" rather than the literal 0.
          const pidLabel = profile.pid ? `pid ${profile.pid}` : 'attached';
          // `profile.name` is the BARE profile; the endpoint is its own field,
          // so the row reads `comet-local (endpoint: endpoint-0, port …)`
          // instead of the raw `comet-local@endpoint-0` key.
          const endpointLabel = profile.endpoint ? `endpoint: ${profile.endpoint}, ` : '';
          console.log(`\n${profile.name} (${endpointLabel}${portLabel}, ${pidLabel})`);
          // A profile whose live state could not be read is still listed, and
          // says so — it is not silently dropped and not shown as healthy.
          if (profile.unavailable) {
            console.log(`  Unavailable: ${profile.unavailable}`);
          }
          if (profile.tasks.length === 0) {
            console.log('  No active tasks');
          } else {
            console.log(
              '  ' +
                'ID'.padEnd(12) +
                'LABEL'.padEnd(20) +
                'TABS'.padEnd(6) +
                'DOMAINS'.padEnd(22) +
                'CREATED',
            );
            for (const task of profile.tasks) {
              const age = formatAge(task.createdAt);
              const id = (task.name || task.id).slice(0, 10);
              const label = (task.label || task.name || task.id).slice(0, 18);
              const domains = task.domains?.slice(0, 2).join(', ') || '-';
              console.log(
                '  ' +
                  id.padEnd(12) +
                  label.padEnd(20) +
                  String(task.tabCount).padEnd(6) +
                  domains.slice(0, 20).padEnd(22) +
                  age
              );
              // The recorded tab count above is what the task owns on disk; this
              // says the live tabs behind it could not be read, so the count is
              // not mistaken for verified-live tabs.
              if (task.unavailable) {
                console.log('  '.padEnd(14) + `↳ tabs unreadable: ${task.unavailable}`);
              }
            }
          }
        }
      }
    });

  browser
    .command('tasks')
    .description('List all browser tasks')
    .option('-p, --profile <name>', 'Filter by profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'status',
        profile: opts.profile ? await resolveProfileRef(opts.profile) : undefined,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      const allTasks: Array<{ profile: string; name: string; tabs: number; domains: string[]; created: number }> = [];
      for (const profile of response.profiles || []) {
        for (const task of profile.tasks) {
          allTasks.push({
            profile: profile.name,
            name: task.name || task.id,
            tabs: task.tabCount,
            domains: task.domains || [],
            created: task.createdAt,
          });
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(allTasks, null, 2));
        return;
      }

      if (allTasks.length === 0) {
        // Show recent history instead
        const historyResponse = await sendIPCRequest({ action: 'history', limit: 5 });
        if (historyResponse.ok && historyResponse.history && historyResponse.history.length > 0) {
          console.log('No active tasks. Recent history:\n');
          console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
          console.log('-'.repeat(75));
          for (const h of historyResponse.history) {
            const domains = h.domains?.slice(0, 2).join(', ') || '-';
            const duration = formatDuration(h.endedAt - h.createdAt);
            const ended = formatAge(h.endedAt);
            console.log(
              h.profile.padEnd(15) +
                h.name.padEnd(18) +
                domains.slice(0, 20).padEnd(22) +
                duration.padEnd(10) +
                ended
            );
          }
        } else {
          console.log('No active tasks');
        }
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'TABS'.padEnd(6) + 'DOMAINS'.padEnd(22) + 'CREATED');
      console.log('-'.repeat(70));
      for (const t of allTasks) {
        const domains = t.domains.slice(0, 2).join(', ') || '-';
        console.log(
          t.profile.padEnd(15) +
            t.name.padEnd(18) +
            String(t.tabs).padEnd(6) +
            domains.slice(0, 20).padEnd(22) +
            formatAge(t.created)
        );
      }
    });

  browser
    .command('history')
    .description('Show recent browser task history')
    .option('-l, --limit <n>', 'Number of entries (default 10)', intOption, 10)
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const response = await sendIPCRequest({
        action: 'history',
        limit: opts.limit,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(response.history ?? [], null, 2));
        return;
      }

      if (!response.history || response.history.length === 0) {
        console.log('No browser task history');
        return;
      }

      console.log('PROFILE'.padEnd(15) + 'TASK'.padEnd(18) + 'DOMAINS'.padEnd(22) + 'DURATION'.padEnd(10) + 'ENDED');
      console.log('-'.repeat(75));
      for (const h of response.history) {
        const domains = h.domains?.slice(0, 2).join(', ') || '-';
        const duration = formatDuration(h.endedAt - h.createdAt);
        const ended = formatAge(h.endedAt);
        console.log(
          h.profile.padEnd(15) +
            h.name.padEnd(18) +
            domains.slice(0, 20).padEnd(22) +
            duration.padEnd(10) +
            ended
        );
      }
    });

  browser
    .command('refs')
    .description('Get DOM refs for interactive elements')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--all', 'Include non-interactive elements')
    .option('-l, --limit <n>', 'Max elements (default 500)', intOption, 500)
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'refs',
        task,
        tabId: opts.tab,
        interactive: !opts.all,
        limit: opts.limit,
      });

      if (!response.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: response.error }));
        } else {
          console.error(response.error);
        }
        process.exit(1);
      }

      // Warn (on stderr, so it never corrupts --json stdout) when the a11y tree
      // exposed nothing to click — the caller should fall back to a screenshot
      // plus coordinate click.
      const count = response.nodes?.length ?? 0;
      if (count === 0) {
        const scope = opts.all ? 'elements' : 'interactive elements';
        console.error(
          `No ${scope} found. The page may render its UI on a canvas or in a custom widget ` +
            `the accessibility tree doesn't expose. Take a screenshot ` +
            `(\`browser screenshot\`) and click by position with \`browser click --at X,Y\`.`
        );
      }

      if (opts.json) {
        console.log(JSON.stringify(response.nodes ?? [], null, 2));
        return;
      }

      console.log(response.refs);
    });

  const click = browser
    .command('click [ref]')
    .description('Click an element by ref, by its visible name with --text, or raw coordinates with --at X,Y')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--at <x,y>', 'Click viewport coordinates (e.g. --at 320,540), bypassing ref resolution', pointArgument)
    .option('--text <name>', 'Click the element with this accessible name (exact, else containing it; first in page order), no `browser refs` needed: --text "Checkout"')
    .option('--role <role>', 'With --text: only elements of this role (button, link, checkbox, …)')
    .option(SNAPSHOT_OPTION_FLAG, SNAPSHOT_OPTION_DESC)
    .addOption(waitOption())
    .option(NO_WAIT_OPTION_FLAG, NO_WAIT_OPTION_DESC)
    .action(async (ref: number | undefined, opts) => {
      const task = resolveTaskName(opts);

      let requestExtra: { ref?: number; atX?: number; atY?: number; text?: string; role?: string };
      if (opts.text !== undefined) {
        if (ref !== undefined || opts.at !== undefined) {
          console.error('Pass one of a ref, --text <name>, or --at X,Y.');
          process.exit(1);
        }
        requestExtra = { text: String(opts.text), role: opts.role };
      } else if (opts.role !== undefined) {
        console.error('--role narrows --text: `browser click --text "Submit" --role button`.');
        process.exit(1);
        return;
      } else if (opts.at !== undefined) {
        requestExtra = { atX: opts.at.x, atY: opts.at.y };
      } else if (ref !== undefined) {
        requestExtra = { ref };
      } else {
        console.error('Provide a ref (`click 5`), a name (`click --text "Checkout"`) or coordinates (`click --at X,Y`).');
        process.exit(1);
        return;
      }

      const response = await sendIPCRequest({
        action: 'click',
        task,
        tabId: opts.tab,
        snapshot: opts.snapshot,
        wait: opts.wait,
        ...requestExtra,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.message ? `Clicked (${response.message})` : 'Clicked');
      printSnapshot(response.snapshot);
    });
  bindArgument(click, 'ref', refArgument);

  browser
    .command('select <target> <option>')
    .description('Choose an option of a <select>, named by its ref or its label, by the option\'s label or value: `browser select 7 "11-12"`, `browser select "Sort" "Price (low to high)"`')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option(SNAPSHOT_OPTION_FLAG, SNAPSHOT_OPTION_DESC)
    .addOption(waitOption())
    .option(NO_WAIT_OPTION_FLAG, NO_WAIT_OPTION_DESC)
    .action(async (target: string, option: string, opts: { task?: string; tab?: string; device?: string; snapshot?: boolean; wait?: boolean }) => {
      const response = await sendIPCRequest({
        action: 'select',
        task: resolveTaskName(opts),
        tabId: opts.tab,
        ...refOrName(target),
        text: option,
        snapshot: opts.snapshot,
        wait: opts.wait,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      console.log(`Selected "${String(response.result)}"`);
      printSnapshot(response.snapshot);
    });

  browser
    .command('type <target> [text]')
    .description('Type text into an element named by its ref or its label: `browser type 3 hello`, `browser type "Email" ada@example.com`, or `--text "hello world"`')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--text <text>', 'Text to type (use quotes for spaces/special chars)')
    .option('--secret <ref>', 'Resolve <bundle>/<KEY> from the `secrets` CLI and type the value. The secret is resolved in-process and never printed to stdout or the transcript. Alternative to --text.')
    .option('--clear', 'Clear editor content before typing')
    .option(SNAPSHOT_OPTION_FLAG, SNAPSHOT_OPTION_DESC)
    .addOption(waitOption())
    .option(NO_WAIT_OPTION_FLAG, NO_WAIT_OPTION_DESC)
    .action(async (target: string, positional: string | undefined, opts) => {
      const task = resolveTaskName(opts);
      if (positional !== undefined && opts.text !== undefined) {
        console.error('Pass the text once: either positionally or with --text.');
        process.exit(1);
      }

      // Resolve the text to type: literal text, or a --secret <bundle>/<KEY>
      // reference resolved in-process so the value never crosses stdout/transcript.
      let text: string | undefined = positional ?? opts.text;
      let site: string | undefined;
      if (opts.secret) {
        if (text !== undefined) {
          console.error('Pass either --text or --secret, not both.');
          process.exit(1);
        }
        const parsed = parseSecretRef(opts.secret);
        if (!parsed) {
          console.error(`--secret must be <bundle>/<KEY>, got: ${opts.secret}`);
          process.exit(1);
        }
        if (!(await bundleExists(parsed.bundle))) {
          console.error(`Secrets bundle "${parsed.bundle}" not found.`);
          process.exit(1);
        }
        try {
          const { env } = await readAndResolveBundleEnv(parsed.bundle, { caller: 'browser type', keys: [parsed.key], keyMode: 'storage', agentOnly: true });
          if (!(parsed.key in env)) {
            console.error(`Key "${parsed.key}" not in bundle "${parsed.bundle}".`);
            process.exit(1);
          }
          text = env[parsed.key];
          site = secretSite(parsed.bundle) ?? undefined;
        } catch (err) {
          console.error((err as Error).message);
          process.exit(1);
        }
      }
      if (text === undefined) {
        console.error('Provide the text (`browser type <target> <text>`) or --secret <bundle>/<KEY>.');
        process.exit(1);
      }

      const response = await sendIPCRequest({
        action: 'type',
        task,
        tabId: opts.tab,
        ...refOrName(target),
        text,
        secretSite: site,
        clear: opts.clear,
        snapshot: opts.snapshot,
        wait: opts.wait,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      // Never echo the typed text — with --secret it would leak the credential.
      console.log(response.message ? `Typed (${response.message})` : 'Typed');
      printSnapshot(response.snapshot);
    });

  browser
    .command('press <key>')
    .description('Press a key (Enter, Tab, Escape, etc)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option(SNAPSHOT_OPTION_FLAG, SNAPSHOT_OPTION_DESC)
    .addOption(waitOption())
    .option(NO_WAIT_OPTION_FLAG, NO_WAIT_OPTION_DESC)
    .action(async (key: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'press',
        task,
        tabId: opts.tab,
        key,
        snapshot: opts.snapshot,
        wait: opts.wait,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.message ? `Pressed (${response.message})` : 'Pressed');
      printSnapshot(response.snapshot);
    });

  browser
    .command('dialog <answer>')
    .description('Answer the confirm() or prompt() the page is showing: `browser dialog accept` or `browser dialog dismiss`')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--text <reply>', 'With accept: the text to answer a prompt() with')
    .action(async (answer: string, opts: { task?: string; device?: string; text?: string }) => {
      if (answer !== 'accept' && answer !== 'dismiss') {
        console.error(`Answer with accept or dismiss, got: ${answer}`);
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'dialog',
        task: resolveTaskName(opts),
        key: answer,
        text: opts.text,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      console.log(response.message);
    });

  const hover = browser
    .command('hover <ref>')
    .description('Hover over an element by ref')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (ref: number, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'hover',
        task,
        tabId: opts.tab,
        ref,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Hovered');
    });
  bindArgument(hover, 'ref', refArgument);

  browser
    .command('scroll')
    .description('Scroll the page by pixel amount (negatives scroll up/left)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--dx <n>', 'Horizontal pixels (negative = left)', intOption, 0)
    .option('--dy <n>', 'Vertical pixels (negative = up)', intOption, 0)
    .option('-x, --at-x <x>', 'X coordinate to dispatch scroll from (default 0)', intOption)
    .option('-y, --at-y <y>', 'Y coordinate to dispatch scroll from (default 0)', intOption)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.dx === 0 && opts.dy === 0) {
        console.error('Pass --dx and/or --dy (at least one must be non-zero)');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'scroll',
        task,
        tabId: opts.tab,
        scrollX: opts.dx,
        scrollY: opts.dy,
        scrollAtX: opts.atX,
        scrollAtY: opts.atY,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Scrolled');
    });

  browser
    .command('upload')
    .description('Upload file(s) — supports hidden file inputs, drag-drop targets, and OS chooser interception')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-r, --ref <n>', 'Ref of the upload target element (file input or drop zone)', refArgument)
    .option('--trigger <n>', 'Ref of a button that opens the OS file chooser (Pattern C)', refArgument)
    .option('-f, --file <path...>', 'Absolute path(s) to file(s) to upload (repeatable)')
    .option('--drop', 'Force drag-drop pattern even if ref is an <input type=file>')
    .option('--input', 'Force file-input pattern (DOM.setFileInputFiles)')
    .option('--timeout <ms>', 'Timeout for chooser interception (Pattern C)', intOption)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const files: string[] = opts.file ?? [];
      if (files.length === 0) {
        console.error('--file <path> is required (repeat for multiple files)');
        process.exit(1);
      }
      if (opts.ref === undefined && opts.trigger === undefined) {
        console.error('--ref <n> or --trigger <n> is required');
        process.exit(1);
      }
      if (opts.drop && opts.input) {
        console.error('--drop and --input are mutually exclusive');
        process.exit(1);
      }

      let mode: 'auto' | 'input' | 'drop' | 'chooser' = 'auto';
      if (opts.trigger !== undefined) mode = 'chooser';
      else if (opts.drop) mode = 'drop';
      else if (opts.input) mode = 'input';

      const response = await sendIPCRequest({
        action: 'upload',
        task,
        tabId: opts.tab,
        ref: opts.ref,
        trigger: opts.trigger,
        files,
        uploadMode: mode,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'} (${response.uploadMode})`);
    });

  // ─── Viewport & Device ───────────────────────────────────────────────────────

  const setCmd = browser.command('set').description('Set browser emulation options');

  const viewport = setCmd
    .command('viewport <width> <height>')
    .description('Set viewport size')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-m, --mobile', 'Enable mobile emulation')
    .option('-s, --scale <factor>', 'Device scale factor', parseFloat)
    .action(async (width: number, height: number, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-viewport',
        task,
        tabId: opts.tab,
        width,
        height,
        mobile: opts.mobile,
        deviceScaleFactor: opts.scale,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Viewport set to ${width}x${height}${opts.mobile ? ' (mobile)' : ''}`);
    });
  bindArgument(viewport, 'width', intOption);
  bindArgument(viewport, 'height', intOption);

  setCmd
    .command('device <device-name>')
    .description('Emulate a device (iPhone 14, iPad, MacBook Pro)')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .action(async (deviceName: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-device',
        task,
        tabId: opts.tab,
        deviceName,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Device set to ${deviceName}`);
    });

  browser
    .command('devices')
    .description('List available device presets')
    .action(async () => {
      const { DEVICES } = await import('../browser/devices.js');
      console.log('Available devices:');
      for (const [name, desc] of Object.entries(DEVICES)) {
        console.log(`  ${name.padEnd(16)} ${desc.width}x${desc.height} @${desc.deviceScaleFactor}x${desc.mobile ? ' (mobile)' : ''}`);
      }
    });

  // ─── Console & Errors ────────────────────────────────────────────────────────

  browser
    .command('console')
    .description('Read console logs from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-l, --level <level>', 'Filter by level (log, info, warn, error)')
    .option('--clear', 'Clear logs after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'console',
        task,
        tabId: opts.tab,
        level: opts.level,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.logs || response.logs.length === 0) {
        console.log('No console logs');
        return;
      }

      for (const log of response.logs) {
        const prefix = `[${log.level.toUpperCase()}]`.padEnd(8);
        const loc = log.url ? ` (${log.url}${log.line ? `:${log.line}` : ''})` : '';
        console.log(`${prefix} ${log.text}${loc}`);
      }
    });

  browser
    .command('errors')
    .description('Read page errors from a tab')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--clear', 'Clear errors after reading')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'errors',
        task,
        tabId: opts.tab,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      if (!response.errors || response.errors.length === 0) {
        console.log('No errors');
        return;
      }

      for (const err of response.errors) {
        console.log(`[ERROR] ${err.message}`);
        if (err.stack) console.log(err.stack);
        if (err.url) console.log(`  at ${err.url}${err.line ? `:${err.line}` : ''}`);
        console.log();
      }
    });

  // ─── Network ─────────────────────────────────────────────────────────────────

  browser
    .command('requests')
    .description('Read captured network requests. --format har emits a HAR 1.2 JSON document.')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-f, --filter <text>', 'Filter URLs containing text')
    .option('--clear', 'Clear requests after reading')
    .option('--format <format>', 'Output format: table (default) or har', 'table')
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      if (opts.format !== 'table' && opts.format !== 'har') {
        console.error('--format must be "table" or "har"');
        process.exit(1);
      }
      const response = await sendIPCRequest({
        action: 'requests',
        task,
        tabId: opts.tab,
        filter: opts.filter,
        clear: opts.clear,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      const requests = response.requests ?? [];

      if (opts.format === 'har') {
        const har = buildHar(requests, {
          creatorName: 'browser-cli',
          creatorVersion: getCliVersion(),
        });
        console.log(JSON.stringify(har, null, 2));
        return;
      }

      if (requests.length === 0) {
        console.log('No requests captured');
        return;
      }

      console.log('METHOD'.padEnd(8) + 'STATUS'.padEnd(8) + 'URL');
      console.log('-'.repeat(72));
      for (const req of requests) {
        const status = req.status ? String(req.status) : '...';
        console.log(`${req.method.padEnd(8)}${status.padEnd(8)}${req.url.slice(0, 100)}`);
      }
    });

  browser
    .command('responsebody <url-pattern>')
    .description('Wait for and read a response body by URL pattern')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--timeout <ms>', 'Timeout in milliseconds', intOption)
    .option('--max-chars <n>', 'Max characters to return', intOption)
    .action(async (urlPattern: string, opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'response-body',
        task,
        tabId: opts.tab,
        urlPattern,
        timeout: opts.timeout,
        maxChars: opts.maxChars,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.body);
    });

  // ─── Wait ────────────────────────────────────────────────────────────────────

  browser
    .command('wait')
    .description('Wait for a condition')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--time <ms>', 'Wait for milliseconds', intOption)
    .option('--selector <css>', 'Wait for CSS selector to appear')
    .option('--url <pattern>', 'Wait for URL to match pattern')
    .option('--fn <js>', 'Wait for JS expression to return truthy')
    .option('--state <state>', 'Wait for load state (domcontentloaded, load, networkidle)')
    .option('--timeout <ms>', 'Timeout in milliseconds', intOption)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      let waitType: 'time' | 'selector' | 'url' | 'function' | 'load';
      let waitValue: string | number;

      if (opts.time !== undefined) {
        waitType = 'time';
        waitValue = opts.time;
      } else if (opts.selector) {
        waitType = 'selector';
        waitValue = opts.selector;
      } else if (opts.url) {
        waitType = 'url';
        waitValue = opts.url;
      } else if (opts.fn) {
        waitType = 'function';
        waitValue = opts.fn;
      } else if (opts.state) {
        waitType = 'load';
        waitValue = opts.state;
      } else {
        console.error('One of --time, --selector, --url, --fn, or --state required');
        process.exit(1);
      }

      const response = await sendIPCRequest({
        action: 'wait',
        task,
        tabId: opts.tab,
        waitType,
        waitValue,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log('Wait condition met');
    });

  // ─── Downloads ───────────────────────────────────────────────────────────────

  browser
    .command('download')
    .description("Set the download directory for a task (defaults to the profile's downloads dir)")
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('-p, --path <dir>', "Download directory path (default: the profile's downloads dir)")
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'set-download-path',
        task,
        tabId: opts.tab,
        downloadPath: opts.path,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(response.downloadPath ? `Download path set to ${response.downloadPath}` : 'Download path set');
    });

  const sessions = browser
    .command('sessions')
    .description('Browse a profile\'s captured screenshots, PDFs, recordings, and downloads, grouped by task')
    .option('--profile <name>', 'Only this profile (default: all profiles with captures)')
    .option('--open [selector]', "Open a capture in the OS default app: 'latest' or a filename")
    .option('--json', 'Emit machine-readable JSON')
    .option('--tasks', 'Include durable task summaries, including tasks without captures')
    .option('--search <text>', 'Search task names, profiles, conversation references and capture names')
    .option('--since <when>', 'Only rows active since (2h, 7d, 4w, 1mo, 1y, or an ISO date)')
    .option('--until <when>', 'Only rows active at or before (relative or ISO date)')
    .option('--limit <n>', 'Cap the flat/--no-interactive listing at this many rows (default 50; --json is unbounded unless given)')
    .option('--no-interactive', 'Print the flat listing instead of opening the interactive task browser')
    .action(async (opts) => {
      await runBrowserSessionsCommand(opts);
    });

  setHelpSections(sessions, {
    examples: '\n  browser sessions\n  browser sessions --since 7d\n  browser sessions --tasks --since 1mo --until 7d --json\n  browser sessions --no-interactive --limit 20\n  browser sessions --open latest\n',
    notes: '\n  Type to search; arrows move; Enter browses captures; Escape goes back.\n  --since/--until keep rows by last activity (task rows) or capture time (profile listing); an invalid value exits 2.\n  Legacy history is adopted on first task listing; migrate safely repeats adoption.\n',
  });
  const migrate = sessions.command('migrate')
    .description('Import existing Agents browser history without modifying the source; safe to repeat')
    .option('--from <path>', 'Legacy sessions.db path')
    .option('--json', 'Emit imported row count as JSON')
    .action(async (opts, command: Command) => {
      const json = command.optsWithGlobals().json;
      const { importLegacyHistory } = await import('../runtime/task-history.js');
      const imported = importLegacyHistory(opts.from);
      console.log(json ? JSON.stringify({ imported }) : `Imported ${imported} browser tasks.`);
    });
  setHelpSections(migrate, { examples: '\n  browser sessions migrate --json\n  browser sessions migrate --from /path/to/sessions.db\n' });

  // ─── Recording ─────────────────────────────────────────────────────────────

  const record = browser.command('record').description('Record a video of the page');

  record
    .command('start')
    .description('Start recording — auto-saved under sessions/<task>/recordings/. Bounded by --fps, --duration, --max-mb.')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('-t, --tab <tabId>', 'Tab ID (defaults to current)')
    .option('--fps <n>', 'Frames per second (1–30, default 5)', intOption)
    .option('--duration <sec>', 'Hard duration cap in seconds (default 60)', intOption)
    .option('--max-mb <mb>', 'Stop when output exceeds this many MB (default 25)', intOption)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'record-start',
        task,
        tabId: opts.tab,
        fps: opts.fps,
        duration: opts.duration,
        maxMb: opts.maxMb,
      });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      // stdout: path (for capture into a variable). stderr: human commentary.
      console.log(response.path);
      console.error(
        `Recording task "${task}" at ${response.fps} fps (cap ${response.durationCapSec}s / ${response.maxMb} MB) → ${response.path}`
      );
      console.error('Stop with: browser record stop');
    });

  record
    .command('stop')
    .description('Stop an in-progress recording')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({ action: 'record-stop', task });
      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }
      console.log(response.path);
      const size = humanizeBytes(response.bytes);
      const seconds = ((response.durationMs ?? 0) / 1000).toFixed(1);
      console.error(`Saved recording to ${response.path} (${size}, ${seconds}s, stopped: ${response.stopReason})`);
    });

  browser
    .command('waitdownload')
    .description('Wait for a download to complete')
    .option(TASK_OPTION_FLAG, TASK_OPTION_DESC)
    .option(DEVICE_ON_PAGE_VERB_FLAG, DEVICE_ON_PAGE_VERB_DESC)
    .option('--timeout <ms>', 'Timeout in milliseconds', intOption)
    .action(async (opts) => {
      const task = resolveTaskName(opts);
      const response = await sendIPCRequest({
        action: 'wait-download',
        task,
        timeout: opts.timeout,
      });

      if (!response.ok) {
        console.error(response.error);
        process.exit(1);
      }

      console.log(`Downloaded: ${response.downloadPath}`);
    });
}

function collect(val: string, memo: string[]): string[] {
  memo.push(val);
  return memo;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function humanizeBytes(n: number | undefined): string {
  if (n === undefined) return 'unknown size';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `${hours}h ${mm}m` : `${hours}h`;
}
