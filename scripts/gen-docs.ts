import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runReferenceScript } from '@phnx-labs/cli-docs';
import { buildProgram } from '../src/index.ts';
import { REFERENCE_OPTIONS } from '../src/runtime/reference.ts';

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    'out-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
});
if (values.help) {
  console.log(`Usage: scripts/generate-cli-docs.sh [--check] [--out-dir <directory>]

Generate the HTML, Markdown and JSON command reference from the registered CLI.
  --check           Report stale or missing files without writing them
  --out-dir <dir>   Write a preview (relative to your current directory)
  -h, --help        Show this help

By default, output goes to this repository's docs/ directory.
Run bun install --frozen-lockfile first. No running services are needed.`);
  process.exit(0);
}
const outDir = values['out-dir']
  ? resolve(values['out-dir'])
  : fileURLToPath(new URL('../docs/', import.meta.url));

runReferenceScript(buildProgram(), { ...REFERENCE_OPTIONS, outDir }, values.check ? ['--check'] : []);
