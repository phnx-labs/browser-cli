#!/usr/bin/env node
import { Command } from 'commander';
import { registerBrowserSubcommands } from './commands/browser.js';
import { version } from './version.js';
import { loadContext } from './runtime/context.js';
import { claimServiceLock, clearServicePid, writeServicePid } from './runtime/service.js';
import { BrowserService } from './browser/service.js';
import { BrowserIPCServer } from './browser/ipc.js';
import { resolveBrowserTaskIdleMs } from './runtime/device-config.js';
import { migrateBrowserHome } from './runtime/home-migration.js';
import { assertBrowserHomeReady } from './runtime/state.js';
import { unbindTask } from './browser/task-index.js';
import { emit, rotateDaemonLog } from './runtime/events.js';
import { pruneActions } from './runtime/session-store.js';

export function buildProgram(): Command {
  const program = new Command()
    .name('browser')
    .description('Drive real browsers over CDP, WebDriver BiDi and native Arc')
    .version(version(), '-v, --version');
  program.hook('preAction', async (_, command) => {
    if (!(await migrateBrowserHome()) && command.name() === '__serve') assertBrowserHomeReady();
  });
  registerBrowserSubcommands(program);
  program
    .command('__serve', { hidden: true })
    .description('Run the browser IPC service in the foreground')
    .action(async () => {
      if (!(await claimServiceLock())) {
        emit('daemon.duplicate', { pid: process.pid });
        return;
      }
      rotateDaemonLog();
      pruneActions();
      emit('daemon.start', { pid: process.pid, version: version() });
      const service = new BrowserService();
      const ipc = new BrowserIPCServer(service);
      await ipc.start();
      // Written once the socket listens, so a client that finds the pid alive
      // and the socket refusing knows the service is gone, not still binding.
      writeServicePid();
      const reaper = startReapTick(service);
      const stop = async () => {
        emit('daemon.stop', { pid: process.pid });
        clearInterval(reaper);
        await ipc.stop();
        clearServicePid();
        process.exit(0);
      };
      process.on('SIGTERM', () => { void stop(); });
      process.on('SIGINT', () => { void stop(); });
      await new Promise(() => {});
    });
  return program;
}

const REAP_TICK_MS = 5 * 60_000;

/**
 * The abandoned-task reaper on the daemon's own clock. A pass still running when
 * the next tick fires is not doubled up.
 */
function startReapTick(service: BrowserService): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { closed, failed } = await service.reapAbandoned({ idleMs: await resolveBrowserTaskIdleMs() });
      for (const c of closed) {
        // Same unbind `browser prune` does, or the caller's next verb routes to a task that is gone.
        unbindTask(c.task);
        emit('reaper.closed', { task: c.task, profile: c.profile, reason: c.reason });
      }
      for (const f of failed) emit('reaper.failed', { task: f.task, profile: f.profile, error: f.error });
    } catch (err) {
      emit('reaper.failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, REAP_TICK_MS);
  timer.unref();
  void tick();
  return timer;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  loadContext();
  await buildProgram().parseAsync(argv);
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

export { registerBrowserCommand, registerBrowserSubcommands } from './commands/browser.js';
export type { BrowserContext, HostTarget } from './runtime/context.js';
