# Browser CLI

Source for `@phnx-labs/browser-cli`, executable `browser`. Extracted from `phnx-labs/agents-cli`; licensed Apache-2.0.

Every tracked change goes through a linked worktree under `.agents/worktrees/` and a reviewed PR. No runtime dependency on Agents CLI. Agents owns fleet discovery, remote-control consent and transcript integration; this package owns browser processes, profile state, the IPC service, drivers and its action protocol.

No prose comment over four lines; `bun scripts/comment-lines.ts --check` runs in CI and the recorded total only goes down. Any change in the comment total must re-record `ceiling` in `scripts/comment-budget.json` to the exact new total.

Use `scripts/build.sh`, `test.sh`, `install.sh`, and `release.sh`. CLI releases publish compiled platform packages and a small npm launcher, without source maps or TypeScript sources. The binaries are compiled from this source. Preserve default-deny remote control, redirected-HOME service protection and the `~/.agents/browser/` layout (offered profile YAMLs in `profiles/`; private settings in `local/`; runtime state in `run/`, `cache/`, `data/`, `logs/` and `logins/`). Never install a development build over the production command. Tests sit beside source and exercise real processes, transports and browser fixtures.

Browser owns task history in `browser/data/history.db` (365 days), plus the existing capture directories. `sessions` on a TTY uses the native searchable picker; `--json` retains its profile/capture shape, while `--tasks` or `--search` selects task rows. `--since`/`--until`/`--limit` match `computer sessions` and the `sessions` time grammar (`src/runtime/time-filter.ts`); keep the two tools identical when changing either. The legacy Agents database is an optional read-only migration source, never a runtime conversation dependency.

The picker, the printed list and its count footer, the format helpers (`formatRelativeTime`, `formatBytes`, `truncate`, `humanDuration`), TTY detection and the pipe-safe stdout writers come from `@phnx-labs/tui` (shared with `sessions` and `computer`); fix them there, not with a local copy. It is consumed as the vendored tarball `vendor/phnx-labs-tui-<version>.tgz` (a devDependency compiled into the binary; the npm launcher never ships it) until it is on the registry. Pass `maxRows: Infinity` to `itemPicker`, which otherwise caps a filtered list at 50 rows. Printed listings go through `printList` (rows on stdout, the `Showing N of M …` footer on stderr) and JSON through `printJson`.

Under Bun, once `process.stdout` is materialized, a `console.log` over 64 KiB to a pipe keeps only the first 65536 bytes. On the `sessions` paths write with the `@phnx-labs/tui` writers (`printJson`, `printLine`, `writeErr`), which retry on EAGAIN. Load `@inquirer/*` only through a dynamic `import()` inside the interactive branch (the package's `itemPicker` already does), test for a TTY with `isInteractiveTerminal`. `scripts/verify-compiled.mjs` pipes over 100 KB and opens the picker in a PTY to catch both.

Editor-window profiles (`browser: editor`, `editor://<name>`, the window's profile name) come from files the Agents VS Code extension (`swarmify.swarm-ext`, repo `phnx-labs/agi-ext`) writes to `$AGENTS_HOME/browser/run/editors/<id>.json` (0600): `{ v: 1, id, app, appVersion, workspace, pid, port, token, startedAt }`. `src/browser/editor-discovery.ts` reads them and never writes. The endpoint names the window (`<editor>-<folder>`), not its port, so a saved alias follows the window across restarts; the token, not `--user-data-dir`, proves ownership. Change the format in both repos together and bump `v`.

## Browser skill

The one browser skill lives at `skills/browser/` (Agent Skills layout) and ships in the npm package. npm's postinstall (`bin/install.cjs`) replaces `bin/browser.cjs` with the platform binary outside Windows, and the binary reads `../skills` beside its own real path; when scripts are skipped `bin/browser.cjs` stays the Node launcher and sets `BROWSER_SKILLS_DIR`. Keep everything for the skill inside that folder (`references/`, `scripts/`); no top-level data directories. The skill lists no flags: agents read `--help` and `browser help --json`, so keep command help complete and correct. Site guides are `references/sites/<site>.md` and are resolved in the CLI process, not the shared service. `src/commands/skill-commands.test.ts` fails when the skill shows a command or flag the CLI does not have, and `scripts/published-files.mjs` is the release allowlist for what the npm tarballs may contain.

## Generated CLI documentation

`scripts/generate-cli-docs.sh` regenerates `docs/command-reference.html` and the
Markdown/JSON command indexes from the registered command tree using
`@phnx-labs/cli-docs`. `--check` compares without writing; `--out-dir <directory>`
creates a preview relative to the caller. Tests check freshness, and `release.sh`
checks it again before pushing a release branch. CI uploads the generated reference
on PRs and `main` / `release/**` pushes. Update and commit all three formats when
command help changes. Generation only registers commands; it never executes them.
