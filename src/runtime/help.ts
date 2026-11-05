/** Grouped subcommand help: verbs listed under titled groups instead of one flat list. */
import type { Command } from 'commander';

export interface CommandGroup {
  title: string;
  names: readonly string[];
}

export interface HelpSections {
  examples?: string;
  notes?: string;
}

const helpSections = new WeakMap<Command, HelpSections>();

export function getHelpSections(command: Command): HelpSections {
  return helpSections.get(command) ?? {};
}

export function setHelpSections(command: Command, sections: HelpSections): void {
  helpSections.set(command, sections);
  if (sections.examples) command.addHelpText('after', `\nExamples:${sections.examples}`);
  if (sections.notes) command.addHelpText('after', `\nNotes:${sections.notes}`);
}

export function registerCommandGroups(parent: Command, groups: readonly CommandGroup[]): void {
  // Commander would otherwise print its own flat "Commands:" block as well.
  parent.configureHelp({ visibleCommands: () => [] });

  parent.addHelpText('after', () => {
    const byName = new Map(parent.commands.map((c) => [c.name(), c]));
    const listed = new Set<string>();
    const width = Math.max(
      ...parent.commands.map((c) => c.name().length),
      12,
    );

    const lines: string[] = [];
    const renderOne = (name: string) => {
      const cmd = byName.get(name);
      if (!cmd || listed.has(name)) return;
      listed.add(name);
      lines.push(`  ${name.padEnd(width)}  ${cmd.description()}`);
    };

    for (const group of groups) {
      const before = lines.length;
      lines.push('', `${group.title}:`);
      for (const name of group.names) renderOne(name);
      // A group whose verbs are all absent (a platform-gated build) would
      // otherwise print a bare heading with nothing under it.
      if (lines.length === before + 2) lines.length = before;
    }

    // Anything the groups forgot still has to be discoverable.
    const ungrouped = parent.commands
      .map((c) => c.name())
      .filter((n) => !listed.has(n) && !n.startsWith('__'));
    if (ungrouped.length > 0) {
      lines.push('', 'Other:');
      for (const name of ungrouped) renderOne(name);
    }
    return lines.join('\n');
  });
}
