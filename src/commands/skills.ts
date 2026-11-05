import * as fs from 'node:fs';
import type { Command } from 'commander';
import { printJson, printLine } from '@phnx-labs/tui';
import { browserSkillDir, findSkillDocument, listSkillDocuments } from '../runtime/skills.js';
import { setHelpSections } from '../runtime/help.js';

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

/** Read the skill shipped with this binary so instructions match the installed command surface. */
export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command('skills')
    .description('The browser skill installed with this CLI: where it is, what it contains, and its documents');

  setHelpSections(skills, {
    examples: `
      # Where the skill is (link agents here; it updates with the CLI)
      browser skills path

      # SKILL.md and every reference document
      browser skills list

      # Read one: the skill, Arc notes, or a site guide
      browser skills get
      browser skills get arc
      browser skills get slack
    `,
    notes: `
      The skill follows the Agent Skills layout: skills/browser/SKILL.md, with
      references/ (arc.md, sites/<site>.md) and scripts/. browser start --url prints
      the matching site guide automatically.
    `,
  });

  skills
    .command('path')
    .description('Print the installed skills/browser directory')
    .action(() => {
      try {
        printLine(browserSkillDir());
      } catch (err) {
        fail(err);
      }
    });

  skills
    .command('list')
    .description('List SKILL.md and its reference documents')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      try {
        const docs = listSkillDocuments();
        if (opts.json) {
          printJson(docs);
          return;
        }
        const width = Math.max(...docs.map((d) => d.name.length));
        for (const d of docs) printLine(`${d.name.padEnd(width)}  ${d.path}`);
      } catch (err) {
        fail(err);
      }
    });

  skills
    .command('get [name]')
    .description('Print a skill document: SKILL.md by default, or a reference such as arc or slack')
    .action((name: string | undefined) => {
      try {
        const doc = findSkillDocument(name ?? 'browser');
        printLine(fs.readFileSync(doc.path, 'utf8').trimEnd());
      } catch (err) {
        fail(err);
      }
    });
}
