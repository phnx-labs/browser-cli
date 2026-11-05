import type { Command } from 'commander';
import { renderJson, rootNode, toNode, walk } from '@phnx-labs/cli-docs';
import { printJson, printLine } from '@phnx-labs/tui';
import { REFERENCE_OPTIONS } from '../runtime/reference.js';
import { setHelpSections } from '../runtime/help.js';

/** The command `names` points at, e.g. ['profiles', 'create']; throws on an unknown name. */
function findCommand(program: Command, names: string[]): Command {
  let cmd = program;
  for (const name of names) {
    const next = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!next) {
      const path = [program.name(), ...names].join(' ');
      throw new Error(`Unknown command: ${path}. Run \`browser help\` to list commands.`);
    }
    cmd = next;
  }
  return cmd;
}

/** Register help as plain command help or the installed command tree in JSON, including arguments,
 * options and notes. */
export function registerHelpJsonCommand(program: Command): void {
  program.helpCommand(false);
  const help = program
    .command('help [command...]')
    .description('Show help for a command; --json prints every command, argument and option as JSON')
    .option('--json', 'Print the command tree as JSON (the whole CLI, or the named command)')
    .action((names: string[], opts: { json?: boolean }) => {
      const target = findCommand(program, names);
      if (!opts.json) {
        target.outputHelp();
        return;
      }
      if (target === program) {
        // Over 64 KiB: printLine retries on EAGAIN where a bare write to a pipe truncates under Bun.
        printLine(renderJson(walk(program, REFERENCE_OPTIONS), rootNode(program, REFERENCE_OPTIONS), REFERENCE_OPTIONS).trimEnd());
        return;
      }
      printJson(toNode(target, names.slice(0, -1).join(' '), REFERENCE_OPTIONS));
    });

  setHelpSections(help, {
    examples: `
      # Options for one command
      browser start --help
      browser help start

      # The whole command tree as JSON
      browser help --json

      # One command as JSON
      browser help profiles create --json
    `,
  });
}
