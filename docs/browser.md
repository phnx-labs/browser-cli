# Using browser-cli

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
described under [Profiles and endpoints](#profiles-and-endpoints).

Supported backends:

- Chromium-family over CDP (Chrome, Brave, Edge, Chromium, Comet)
- Firefox over WebDriver BiDi
- Arc profiles on macOS via Apple Events (a task opens in an Arc window of its own, which `screenshot` captures through the Computer helper without raising it)

Safari is not supported.

Remote hosts are bound at `start` with `--device <alias>` (resolved against
`~/.ssh/config`) or reached through an `ssh://` profile endpoint. Fleet
`--device` names are resolved by Agents CLI and handed over on the inherited
context descriptor.

## First run

```sh
browser profiles create work --browser chromium
browser start --profile work --url https://example.com   # prints the task name, e.g. 3f2a9c1d
browser screenshot -o shot.png --task 3f2a9c1d
browser done --task 3f2a9c1d
```

`start` launches (or attaches to) the browser for a profile and opens a **task** —
a named browsing context with its own tabs and capture ledger. Page verbs like
`navigate` and `screenshot` attach to that task: they resolve the caller's live
task, or take `--task <id>` to pick one explicitly. `done` closes the task's
tabs; `browser stop` stops the whole service.

Run `browser --help` for the full verb list and `browser <verb> --help` for its
options.

## Driving a page

The loop an agent runs: list what it can act on, act, read the result.

```sh
browser start --url https://example.com --snapshot   # task name, then the page's refs
browser refs                               # numbered interactive elements
browser text                               # title, URL and the readable text
browser click 3 --snapshot                 # act, then print the page it left
browser click --text "Checkout"            # by accessible name, optionally --role button
browser type 5 "ada@example.com"           # text positionally, or --text
browser type "Email" "ada@example.com"     # or name the field by its label
browser type 9 "19:45"                     # date and time inputs take their value
browser select 7 "Large"                   # a <select> option by label or value
browser press Enter --snapshot
browser dialog accept                      # or dismiss: answers a confirm() or prompt()
browser navigate https://shop.example/p/1 && browser click --text "Add to cart" && browser text
```

- **Refs** are numbers from the latest listing. Add `--snapshot` to `start`,
  `click`, `type`, `select` and `press`: it prints the new URL, title and refs
  in the same call. Every action returns once the page has settled (Chrome-family
  browsers; `--no-wait` returns as it lands), so steps chain with `&&`. A ref keeps naming its element while that element is on
  the page, even when a number in its label changes; one that drifted is
  re-matched by role and name before the action, within the same frame.
- **Dialogs.** An `alert()` or leave-page prompt is accepted and printed. A
  `confirm()` or `prompt()` waits: the action that raised it prints the
  question, and `browser dialog accept|dismiss` answers it.
- **iframes.** In Chromium-family browsers, `refs` lists elements inside
  same-site and cross-site iframes under an `- iframe "<url>"` line, and
  `click`, `type`, `hover` and `select` act on them; `text` reads them too.
  One level of frames below the page is covered. `upload` into a cross-site
  iframe is refused with the frame's URL.
- **Off-screen elements** are scrolled into view before a click or hover.
- **Pages without usable refs** (canvas apps, custom widgets): take a
  `screenshot` and click by position with `click --at X,Y`.
- **Many steps in one process:** `browser stream` reads NDJSON requests on
  stdin and keeps one connection to the service open.

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

## Profiles and endpoints

A **profile** names a browser, where it runs, and how to reach it. Profiles are
stored under `~/.agents/browser/profiles/<machine>.yaml`, or
`~/.agents/browser/local/profiles.yaml` for ones only this machine sees.

```sh
browser profiles create work --browser chrome            # local Chrome, auto-assigned CDP port
browser profiles create hl --browser chromium --headless # headless Chromium
browser profiles list
browser profiles logins          # signed-in services and accounts per profile
browser profiles logins --json   # [{"profile","service","account"} | {"profile","service":null,"account":null,"unread"}]
```

`logins` reads each profile's cookie store where its browser keeps it: Arc's
`User Data/<profile dir>`, Comet's own user-data dir, a pinned `userDataDir`,
or the runtime dir browser launched into. A store it cannot read here (a
profile declared on another device, a browser reached over `ssh://`, Firefox,
a profile never launched on this machine) is listed as `(not read: <reason>)`,
and in `--json` as one `{"profile", "service": null, "account": null,
"unread"}` row, so a profile with no rows had its store read and has no live
session.

Each profile resolves to an endpoint:

- `cdp://127.0.0.1:9222` — a Chromium-family browser over the DevTools Protocol.
- `bidi=firefox-bidi://127.0.0.1:9674` — Firefox over WebDriver BiDi.
- `ssh://user@box?port=9222` — a browser on a remote host reached over SSH.

## Remote browsers

Bind a task to a browser on another machine with `--device` on `start`:

```sh
browser start --device box --profile work
browser navigate https://example.com
browser screenshot -o shot.png
```

`--device <alias>` resolves against `~/.ssh/config`, and against an inherited
context descriptor when the CLI runs under agents-cli. browser-cli itself does
not read a fleet registry. Use `--device local` to force the task onto this
machine. The device is bound once at `start`; page verbs run against the task's
bound device, so `--device` is only valid there.

## Agent skill

The package ships the browser skill in the standard Agent Skills layout, so
agents learn the CLI from the version that is installed:

```
skills/browser/
  SKILL.md                    # workflow, defaults, where to look for flags
  references/arc.md           # Arc limits and sharing the user's window
  references/sites/<site>.md  # per-site guides (higgsfield, linkedin, perplexity, slack)
  scripts/slack/*.js          # page scripts the Slack guide runs with evaluate --file
```

```bash
npx skills add phnx-labs/browser-cli    # install into your agents
browser skills path                     # the installed copy (link agents here)
browser skills get arc                  # read one document
browser help --json                     # every command, argument and option
```

The skill lists no flags. Agents read `browser <command> --help` or
`browser help --json`, which always match the installed binary.
`browser start --url` prints the site guide for that host.

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

## Platform support

| Platform | Architectures |
| --- | --- |
| macOS | arm64, x64 |
| Linux | arm64, x64 |
| Windows | x64 |

Chromium CDP, Firefox BiDi and SSH endpoints work on all three. Native Arc
control is macOS-only. Safari is not supported.

## Troubleshooting

- **Headless on Linux.** A headless Chromium or Brave needs the usual shared
  libraries (fonts, `libnss3`, `libatk`, `libgbm`, and friends). Install your
  distribution's chromium package to pull them in; a missing library shows up as
  the browser process exiting immediately after `start`.
- **"No usable sandbox" in a container.** Chromium's sandbox needs user
  namespaces, which Docker's default seccomp profile blocks, so Chromium exits
  at launch. Run the container with `--security-opt seccomp=unconfined` (or a
  seccomp profile that allows `clone` with `CLONE_NEWUSER`), or run on a host
  or VM. browser-cli does not pass `--no-sandbox` for you.
- **Port already in use.** Each profile binds a debugging port. If `start`
  reports a squatted port, another browser or a stale process holds it — stop it,
  or create the profile with a different `--endpoint`.
- **Comet and Arc.** Comet is driven as a Chromium-family browser over CDP and
  works best as an attach-only profile against a browser you already launched.
  Arc is always attach-only and macOS-only. Its tasks open in an Arc window of
  their own; `screenshot` captures that window through the Computer helper
  (`computer setup`) without bringing Arc forward.
- **Service state.** `browser status` shows whether the IPC service is running
  and lists active tasks. `browser stop` shuts the service down.

## History, state and logs

`browser sessions` opens a searchable task and capture picker in a terminal.
Use arrows to move, Enter to browse or open a capture, and Escape to go back.
`--no-interactive` keeps the printed listing; `--json` keeps the existing
profile/capture schema. Add `--tasks` for durable task rows, including tasks
without captures, or `--search <text>` to filter those rows.

The same core filters as `sessions` apply to the picker, the printed listing
and `--json`: `--since <when>` / `--until <when>` take `2h`, `7d`, `4w`, `1mo`,
`1y` or an ISO date and keep rows by last activity (capture time in the
profile listing), and an invalid value exits 2. `--limit <n>` caps the printed
listing (default 50); `--json` is unbounded unless `--limit` is given. The
count footer (`Showing 50 of 120 tasks. --limit 120 or --json to see all, …`)
goes to stderr, so piped stdout carries rows only. The picker header names the
active filters.

```bash
browser sessions --since 7d
browser sessions --tasks --since 1mo --until 7d --json
browser sessions --no-interactive --limit 20
```

Browser owns 365-day task summaries in `browser/data/history.db` under
its configured Agents home. Neither Agents nor Sessions needs to be installed.
On first task listing it adopts legacy browser summaries read-only;
`browser sessions migrate [--from /path/to/sessions.db] --json` repeats the
import safely. Captures stay in place and are never deleted by summary retention.
Browser state lives under `~/.agents/browser/` (or `$AGENTS_HOME/browser/`).
Offered profiles sync in `profiles/<device>.yaml`; only that device writes its file.
Private profile declarations use the same name-to-configuration map in
`local/profiles.yaml` and override this machine's offered declarations.
Consent lives in `local/settings.yaml`, outside fleet sync. Runtime sockets and
locks use `run/`, captures and browser caches use `cache/`, kept sign-ins use
`logins/`, and logs use `logs/`. Before running a command, the CLI or daemon
migrates old folders under one exclusive lock. Once complete, subsequent commands
check the local marker and legacy paths without taking migration or Agents config
locks. Recreated legacy folders trigger another migration. If the migration lock
is unavailable, the CLI warns; commands that need no daemon can continue, while
starting a daemon waits for a successful retry. Existing directories merge;
conflicting files are retained under `local/migration-conflicts/` with a warning
naming both copies. History rows merge transactionally, so a fresh database does
not hide old tasks. Tombstone files prevent old binaries from recreating migrated
folders. Live browser stores are left in place: close the named browser and rerun
the command, then restart the service before using that profile.

Logs are JSON lines with a `ts` field, read with `tail` and `jq`. Every request
the CLI sends appends one record (command, task, profile, `ok`, `error`, `ms`) to
`logs/actions/<UTC day>.jsonl`, kept 30 days. The daemon writes launches, closes,
navigations, screenshots, reaper results, lost connections and save failures to
`logs/daemon.jsonl`; a repeated failure is written once, then at its 10th, 100th
and 1000th occurrence with `count`, and starts over after ten quiet minutes. URLs
are logged without credentials, query or fragment, which can carry tokens; a
`data:` or `javascript:` URL is logged as its scheme alone. At
start the daemon rolls a `daemon.jsonl` over 10 MB to `.1`, keeping three.
`logs/browser-service.log` holds only what the daemon prints to stderr, such as
a crash.

```sh
tail -3 ~/.agents/browser/logs/actions/$(date -u +%F).jsonl | jq .
jq -c 'select(.error)' ~/.agents/browser/logs/daemon.jsonl
```

Migration renames only within the selected `AGENTS_HOME`; inherited Agents
cache/history/helper/log overrides cannot move another home's data. `EXDEV`
means the source and destination are on different filesystems: the CLI leaves
the source untouched and names both paths. Stop browsers using that source,
move it by hand into the named destination without overwriting existing files,
and rerun the current CLI. Other move failures also warn without stopping the
service. An old daemon that cannot be identified or stopped is left intact;
status and configuration remain available, but driving is blocked until it is
stopped and the new service is restarted.
During this release, offered profiles are also written to the legacy device file
for older peers; new profile YAMLs take precedence when reading both layouts.

## Using it through agents-cli

Agents CLI ships `agents browser` as a thin consumer of this binary. It forwards
every verb unchanged and adds the concerns it owns: fleet device discovery
(`--device` becomes an SSH target), agent-session identity, remote-control
consent, and cross-machine session history. The seam between the two — the
inherited context descriptor, the event stream, and the shared on-disk paths —
is documented in [docs/integration.md](integration.md). The command
reference is [command-index.md](command-index.md).
