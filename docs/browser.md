# Browser

Drive Chromium-family browsers, Firefox and Arc from the `browser` CLI.

```sh
browser profiles create work --browser chrome
browser use work
browser start
browser navigate https://example.com
browser screenshot
browser done
```

The CLI manages browser processes, tab lifetimes and network capture through its
own IPC service. Each invocation creates or reuses a named **task**. Profiles are
machine-local by default and live in `~/.agents/devices/<machine>/agents.yaml`.

Supported backends:

- Chromium-family over CDP (Chrome, Brave, Edge, Chromium, Comet)
- Firefox over WebDriver BiDi
- Arc profiles on macOS via Apple Events (a task opens in an Arc window of its own, which `screenshot` captures through the Computer helper without raising it)

Safari is not supported.

Remote hosts are bound at `start` with `--device <alias>` (resolved against
`~/.ssh/config`) or reached through an `ssh://` profile endpoint. Fleet
`--device` names are resolved by Agents CLI and handed over on the inherited
context descriptor.

## Skill and help

The browser skill ships inside the package at `skills/browser/` (Agent Skills
layout: `SKILL.md`, `references/`, `scripts/`). The installed binary sits in the
package's `bin/` and reads `../skills`; when install scripts were skipped, the
npm launcher passes the location as `BROWSER_SKILLS_DIR`. A development run of
`dist/<platform>/browser` sets it by hand (`BROWSER_SKILLS_DIR=$PWD/skills`).

- `browser skills path` prints the installed `skills/browser` directory.
- `browser skills list [--json]` lists `SKILL.md` and its reference documents.
- `browser skills get [name]` prints `SKILL.md`, or a reference such as `arc`
  or a site guide such as `slack`.
- `browser help [command...] [--json]` prints a command's help; `--json` prints
  the command tree (every command, argument, option, example and note) in the
  shape of `docs/command-index.json`.

`browser start --url` prints the site guide whose file name matches the host
(`app.slack.com` matches `references/sites/slack.md`), or whose frontmatter
`domains:` list names it. `--no-skills` skips it. When the skill cannot be
located, start still runs and prints a warning saying why.

## Fewer round trips

An agent's real cost per step is the number of commands it runs, not the
milliseconds inside each one. `navigate`, `click`, `type`, `select` and `press`
take `--snapshot`: after the action settles (a navigation it started is waited
for, up to 3 seconds), the command also prints the page url and title and the
same interactive ref listing `browser refs` would print next, numbered
identically. Without `--snapshot` the command settles the same way and prints
nothing extra, so steps the agent already knows chain in one shell call, each
seeing the page the last one led to; a navigation also waits up to 1.5 s for the
requests that draw the page after its load. `--no-wait` returns as the action
lands. Settling needs a Chrome-family browser; on Firefox and Arc the command
returns as the action lands.

```sh
browser click 4 --snapshot
browser navigate https://shop.example/p/1 && browser click --text "Add to cart" && browser text
```

`BROWSER_TRACE=1` in the daemon's environment logs the time spent in every IPC
request and every CDP call to the service log, for finding where an action's
latency actually goes.

See [integration.md](integration.md) for the agents-cli seam.

### Independent task history

`browser sessions` searches and browses tasks and captures interactively. Enter opens the selected task or capture; Escape returns to the previous list. `--no-interactive` prints the existing capture table, and `--json` retains profile-grouped captures. Use `--tasks --json` for durable task rows or `--search <text>` to filter by task, profile, identity reference or capture name. `--open` respects this filter. `--since <when>` and `--until <when>` use the `sessions` grammar (`2h`, `7d`, `4w`, `1mo`, `1y`, or an ISO date), keep task rows by last activity and profile-listing captures by capture time, apply to the picker, the printed listing and `--json`, and exit 2 on an invalid value. `--limit <n>` caps the printed listing (default 50, matching `computer sessions`); the count footer (`Showing 50 of 120 tasks. --limit 120 or --json to see all, --search or --since to narrow.`) goes to stderr, so piped stdout carries rows only; `--json` is unbounded unless `--limit` is given. The picker header names the active filters, for example `Browser history (since 7d · search "review"):`.

Task summaries persist for 365 days under `.history/browser/history.db`, independently of the 30-day action ledger and without Sessions installed. Existing browser summaries are imported read-only on first task listing; `browser sessions migrate --from /path/to/sessions.db --json` safely repeats adoption. Capture files are never moved or deleted by this migration or summary retention.
