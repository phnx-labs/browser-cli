# Changelog

## Unreleased

- `browser click` with a ref or `--text` no longer prints a bare `Clicked` when nothing landed. Before pressing, it asks the page what sits at the element's centre. If something else covers it, the element is clicked through the DOM instead of with the mouse, never both, and the output names the cover: `Clicked (div#veil "Accept cookies" covers button "Buy", so it was clicked through the DOM)`. If the press never reaches the element, the output says `the click may not have reached button "Buy"; check the page`; the click is not repeated, because a page that consumed it cannot be told apart from one that never got it. A disabled element, including a control inside `<fieldset disabled>`, exits 1 with `button "Buy" is disabled; nothing was clicked.` Every click used to print `Clicked`, even when nothing happened, and an agent on saucedemo.com spent 9 turns finding out.
- `browser text` reads lazy parts of a page first. A visible `include-fragment` with a `src` (GitHub's release assets and similar) is scrolled into view until it loads, for at most 4 s, and the page and any scrolled container are put back where they were. Hidden or failed fragments are skipped, so they add no wait. A part still loading after that is reported on stderr (`1 part is still loading after 4 s; run \`browser text\` again to read it.`). The assets list used to read `Loading`, and `--grep` for a file name missed.
- `browser text` and `browser evaluate` retry once, after 500 ms, when they arrive between a navigation and the new document (`Cannot find default execution context`), which happened right after `browser start`.
- The browser skill's `evaluate --file -` example fetches other pages with one `Promise.all(urls.map(…))` expression. Agents copied an `async` function shape instead, which Claude Code refuses ("Contains brace with quote character").

## 0.2.1

- `browser show` into native Arc uses an agent window when no other Arc window is visible. It skipped the recorded agent window and every retired one, so once the owner was working in one, every `show` failed with `"via": "none"` and "No visible Arc window shows a Space of Arc profile". Another visible window is still preferred, so a task's window is left alone whenever there is a choice (`pickShowSpace`).
- `browser type --secret` works. It read bundles with `secrets export <name> --json`, a command the `secrets` CLI does not have, so every call failed with `Could not resolve secrets bundle`; a profile's `--secrets` binding failed the same way and launched without its variables. Values now come from `secrets exec`.
- A secret from a bundle named after a site types only into a field on that site or its subdomains: `browser type "Password" --secret stripe.com/PASSWORD` on any other site, including a cross-origin iframe on a stripe.com page or a `--tab` aimed elsewhere, prints `Refused: this secret types only into stripe.com, and the field is on <host>. Nothing was typed.` and exits 1. A bundle whose name is not a host (`logins`) types anywhere, as before.
- Firefox installed without root now works on Linux. A fresh Firefox tarball keeps its profiles in `$XDG_CONFIG_HOME/mozilla/firefox` (`~/.config/mozilla/firefox`), which profile discovery now reads beside `~/.mozilla/firefox` and the snap path. On every platform, when none of a browser's standard install paths exist, `browser` looks its binary name up in the absolute directories on `PATH` (relative entries such as `.` are skipped), so a Firefox in `~/.local/bin` starts. Two profile roots that resolve to the same directory, such as `~/.mozilla/firefox` symlinked to the XDG one, list each profile once. Before, 0.2.0 listed no Firefox profile on such a machine and then said `Browser "firefox" not found. Install it first.`

## 0.2.0

- browser-cli is licensed under the Apache License 2.0, replacing FSL-1.1-Apache-2.0.
- The release build no longer obfuscates the bundle: each platform binary is compiled straight from the published source. The binaries are still compiled per platform, with no source maps or TypeScript sources in the npm packages.
- Every package is published with `npm publish --provenance`, so npm links each version to the commit and the GitHub Actions run that published it.

## 0.1.40

- `browser show --help` says what showing a page twice does: it reloads and focuses the tab already showing it instead of opening another. The browser skill adds that a tab a task opened with `browser start` is never reused. Behavior is unchanged from 0.1.35.

## 0.1.39

- A ref or integer past `Number.MAX_SAFE_INTEGER` is rejected before the daemon is contacted. `browser hover 99999999999999999999` used to send `ref` `100000000000000000000` (`1e20`).
- A ref or integer that is not a whole number is rejected before the daemon is contacted. `browser hover abc` used to send `ref: NaN` (the socket wrote `"ref":null`); `click abc` already stopped with an error. `--timeout`, `--limit`, `--at-x`, `--at-y` and the other integer flags parse in base 10. A default or a repeated flag used to become `parseInt`'s radix, so `--at-x 10` with a previous value of 8 was read as octal. A value with anything but digits (`12abc`, `1.5`, `0x10`, an empty string, a negative ref) is now an error instead of being truncated or read as 0, and `wait --time 0` waits 0 ms instead of asking for a condition.

## 0.1.38

- `browser show` on a box whose `browser.device` hub is another machine shows the page there, where the person reads it: a local file is copied to the hub's `~/.agents/.cache/remote-artifacts/<this machine>/<its absolute path>` over ssh (showing it again lands on the same path, so the hub reuses its tab), then the hub's own `show` opens it in its viewer, and `--json` adds `"device"`. It used to run `xdg-open` on the box itself, which on a machine with no display reported `{"via":"open"}` while nothing opened anywhere. A `file:` URL is copied the same way; any other URL opens as the hub sees it, so `http://localhost:3000` is the hub's own port. A `--profile` declared on this box still shows it here. The hub must be a macOS or Linux machine. The relay cannot carry a file, so a local file fails there with a clear error. The copy runs `scp -s` (SFTP, so the hub's shell never expands the path), which needs OpenSSH 8.7 or newer on this machine.
- `browser show` succeeds only when the viewer confirms the page: a native Arc tab must report the page (or, after a redirect, any page other than the one it showed before) within 5 s, else a new tab is closed, and the OS handler must exit 0 (or still be running as the browser after 10 s). It used to report `"via":"open"` once `open`/`xdg-open` merely started. On Linux with no `DISPLAY` or `WAYLAND_DISPLAY` it fails at once, and every failure exits 1 and prints its reason. On Windows the OS handler is PowerShell's `Start-Process`, since `explorer.exe` exits 1 after opening.
- `browser screenshot` works on native Arc. An Arc task's tabs open in an Arc window of the agent's own (recorded in `~/.agents/browser/run/arc-agent-window.json`), opened behind the user's apps the first time a task needs it and reused after that, so the user's window keeps its tab and Arc is not brought forward (on the test Mac the frontmost app and the user's selected tab were the same before and after). `screenshot` selects the task's tab in that window, captures the window by its macOS window number through the Computer helper (`computer screenshot --window-id`; `computer setup` holds the Screen Recording permission), keeps the frame only when the window's title is the tab's, and crops to the page, so Arc's sidebar listing the user's tabs is never in the image; it refuses unless the agent window's sidebar is anchored. Arc screenshots used to fail with "Native Arc does not support screenshot", and agents switched to another browser to get a picture. A task opened in the user's window before this change still refuses, and the skill now tells agents never to switch browsers for a step Arc cannot do, and to check a local file headlessly with `--device local` instead of `show`.

## 0.1.37

- Browser state moves to `~/.agents/browser/`: fleet profile declarations in `profiles/`, private profiles and consent in `local/`, runtime files in `run/`, history in `data/`, sign-ins in `logins/`, captures and cache in `cache/`, and logs in `logs/`. The first CLI or daemon command stops the old daemon and migrates under an exclusive lock before creating state. Completed migrations skip both migration and Agents config locks on later commands; recreated legacy folders are still recovered. If the migration lock is unavailable, commands that need no daemon can continue with a warning. Existing destinations merge; conflicting files are retained in private backups, old history rows survive a fresh new database, and tombstones stop old binaries from recreating migrated folders. In-use stores and failed renames stay in place with repair instructions; they do not prevent the service from starting. `AGENTS_HOME` relocates this tree; the narrow runtime/actions overrides are removed. Legacy moves stay within the selected `AGENTS_HOME`, regardless of inherited Agents directory overrides. ffmpeg stays in place.
- During rollout, offered profiles are written to both `browser/profiles/<device>.yaml` and `devices/<device>/agents.yaml` and both layouts are read, with the new file authoritative. Remove this dual write/read in the next release after the fleet upgrades. Remote-control consent migrates once to local settings and is removed from the synced device file.
- Two timestamped JSON-lines logs under `~/.agents/browser/logs/`, read with `tail` and `jq`. `actions/<UTC day>.jsonl` gets one record per request the CLI sends (command, task, profile, session, `ok`, `error`, `ms`), and files older than 30 days are removed when the daemon starts. `daemon.jsonl` records daemon start and stop, launches, closes, navigations, screenshots, reaper results, lost browser connections, save failures and a stale daemon version. URLs in both logs keep only origin and path, never credentials, query or fragment; a `data:` or `javascript:` URL keeps only its scheme. The same failure for the same task is written once, then at its 10th, 100th and 1000th occurrence with a `count`, and is written again once it has been quiet for ten minutes: on one machine the reaper had written 26,669 near-identical `Owned Arc tab has no stable id` lines to `browser-service.log`. At start, a `daemon.jsonl` over 10 MB rolls to `daemon.jsonl.1`, keeping three. `browser-service.log` now holds only the daemon's stderr, such as a crash. The empty usage-recording hooks are removed.

## 0.1.36

- `browser show` works in Arc again. 0.1.35 raised the window holding the tab with `set index of window`, which Arc refuses (`AppleEvent handler failed (-10000)`), so every Arc `show` created the tab, failed and closed it. It now selects the tab and brings Arc to the front.

## 0.1.35

- `browser show` opens the page in the configured viewer (`browser.viewer`, else `browser.profile`; `--profile` picks another, `--os-browser` keeps the OS handler) and reuses the tab already showing it. A tab no task owns whose URL matches, ignoring the `#fragment` and a trailing slash, is navigated to the URL asked for (so `report.html#section-3` lands on that section) and brought to the front, in a Chromium profile over CDP and in native Arc over Apple Events, where the window holding it is raised. Every call used to hand the URL to `open`/`xdg-open`, so an agent re-showing a report it had just updated left one more copy in the sidebar each time. `--json` reports `"reused": true` when it reused a tab; `--fresh` always opens a new one. It falls back to the OS handler only when the viewer is not a usable profile or the browser service cannot be reached, and `--json` then says so with `fellBackFrom` and `reason`; a viewer that refuses (its browser is not running, say) fails with the reason instead of opening a second copy elsewhere. Captures that `browser sessions` opens (`.html`, `.svg`) go through the viewer too.
- Task history saves again on machines whose `history.db` predates the `native` column; every save there failed with `table tasks has no column named native`.
- A browser profile that only another machine declares, such as `--profile comet-local` on a box where only `laptop` declares it, now runs on that machine exactly as `--device laptop` would, so the laptop's `browser remote-control` setting decides whether it may be driven. This machine's service used to open an SSH tunnel straight to the laptop's debugging port, which skipped that check. `browser start` and a page verb's first `--profile` forward and print `Using <profile> on <device>`; anything else that reaches the service with such a profile is refused with the `browser start --profile <name> --device <device>` command to run.
- A stale browser daemon now prints one restart hint: `daemon is <version>, CLI is <version>: run browser stop --service`. The standalone CLI no longer requests a self-update that always declines.
- `browser logs` is removed, with the `logDir` and `logHost` profile keys it read. It tailed the JSONL logs of a retired app and had nothing to read anywhere else. `browser console`, `errors` and `requests` are the page's own logs.
- A browser that exits while `browser start` launches it is reported in its own words: the error names its exit code and the first five lines it wrote to stderr, such as Chromium's `No usable sandbox!` in a container under Docker's default seccomp profile. It used to surface only as `read ECONNRESET` or `CDP connection closed`.

## 0.1.34

- `browser start --device NAME` and the verbs that follow it reach a device over HTTPS when `BROWSER_RELAY_URL` and `BROWSER_RELAY_TOKEN` are set, for a caller that cannot ssh to it, such as a cloud sandbox reaching a laptop behind NAT. The verb travels as argv, never a shell line, and a screenshot or PDF it writes comes back through the same relay. Unset, `--device` stays on ssh.

## 0.1.33

- `browser text --grep` with no matching line says so on stderr and exits 0. Exiting 1 ended the agent's `&&` chain on a miss, which cost a turn in Browser Use Bench runs.
- The skill tells agents to read with `text --css` and `text --grep` before writing an `evaluate` script; in Browser Use Bench runs on 0.1.32 they rarely used `--css`, and Claude Code refused many of their scripts.

## 0.1.32

- `browser text --css <selector>` prints the text of each element the selector matches, one block per match, and `--attr <name>` prints each match's attribute instead (`href` and `src` absolute). In Browser Use Bench runs, 47 of 109 `evaluate` scripts were `querySelectorAll(...).map(...)` list extractions, and Claude Code refused many such scripts for a quote inside braces; a selector on the command line needs no script.

## 0.1.31

- `browser evaluate` runs scripts as the DevTools console does, so a top-level `const` declared by an earlier call on the same page can be declared again. The skill's advice to put strings in `const` variables made the second script on a page fail with "Identifier … has already been declared".
- The skill says `browser screenshot -o <path>` creates the folder; agents ran `mkdir -p shots` first, which Claude Code stops to ask about where only `browser` commands are allowed.

## 0.1.30

- The skill shows how to write `evaluate` scripts that Claude Code runs without asking. Claude Code refuses a command with a quote inside `{…}` ("Contains brace with quote character") or a `\u00a0` escape ("Contains Unicode whitespace"); in a Browser Use Bench run that refused six of an agent's scripts. Each form the skill recommends was checked against headless Claude Code.

## 0.1.29

- `browser text --grep <pattern>` prints only the lines that match (case-insensitive), two lines around each (`--context <n>`), after the title line; no match exits 1. On Browser Use Bench tasks, Claude Code asked before every `browser text | grep …` or `| python3 …` where only `browser` commands were allowed, five denied calls on one task. The skill now keeps filtering inside `browser`.

## 0.1.28

- `browser evaluate --file -` reads the script from stdin (`browser evaluate --file - <<'JS' … JS`), also for a task on another machine, where the script is sent as the expression. On Browser Use Bench tasks, Claude Code allowed browser-cli only `browser …` commands, so the agent could not write a script file for `--file` and lost five turns to denied writes; Browser Use and browser-harness pipe Python to their CLI the same way.

## 0.1.27

- `start --url`, `navigate`, `click`, `type`, `select` and `press` return once the page has settled, without `--wait` (requests over `browser stream` too, unless they send `"wait": false`); `--no-wait` returns as the action lands. A navigation also waits for the requests that draw the page after its load (up to 1.5 s), so a shop's product list is there for the next command. In the benchmark, agents that left out `--wait` read the page being left, then spent a turn on `sleep 2` and a second read (the form and Demoblaze tasks). `--wait` is still accepted.
- `start --url` returns once the page has loaded. Without `--snapshot` it returned as the tab opened, so `browser start --url … && browser text` read `about:blank`.
- A second `start` without `--task` from an agent session that already drives a task on that profile goes on in that task (navigating it to `--url`). Agents ran `start` again to go back to a page; the second task made every later verb stop with "Multiple browser tasks for this session". Only a task on the same profile and endpoint, whose browser still answers, is reused; two such starts at once share one task. `--task <name>` or `--fresh` still opens a second one.
- `type` and `select` take the element's label instead of a ref: `browser type "First Name" Grace`, `browser select "Sort" "Price (low to high)"`. A known form or checkout chains in one shell call with no listing in between; on Saucedemo the agent listed the page before each form (8 to 9 turns against Browser Use's 4 to 5). A whole number is still a ref.
- `click --text` waits up to 3 s for an element the page draws after loading. `start --url https://www.demoblaze.com/ && browser click --text "Samsung galaxy s6"` failed with "No element named" because the product list arrives by request after the load.
- `browser text` prints a no-break space as a plain space. Wikipedia writes "Population\u00a0(2022 census)", so `browser text | grep "Population (2022"` matched nothing and the agent fell back to four `evaluate` attempts.
- A ref keeps naming its element when a count after its label changes from a word to a number: "Cart, empty" to "Cart, 2 items". The click was refused with "could not be re-resolved", and the agent spent a turn listing the page again.
- The skill no longer passes `--task`: later calls drive the task the caller's `start` opened. Agents put the name in `$T`, and Claude Code stopped to check the command ("A variable in this command can't be checked before it runs"), one turn in four of the 16 benchmark runs. It also shows chaining a read onto an action (`&& browser text | grep -A3 Total`).

## 0.1.26

- browser-cli is open source at [github.com/phnx-labs/browser-cli](https://github.com/phnx-labs/browser-cli), under the same FSL-1.1-Apache-2.0 license. Packages are now published from that repository, so npm shows their build provenance. No behavior changes.

## 0.1.25

- `--wait` on `navigate`, `click`, `type`, `select` and `press` returns once the page has settled, like `--snapshot` but without printing the listing (Chrome-family browsers; on Firefox and Arc it returns as the action lands). Without either flag a click or navigate returns as soon as it lands, so a chained `browser text` read the page being left; in the benchmark agents added `sleep 2` and a second read. Steps the agent already knows now chain in one shell call: `browser navigate … --wait --task t && browser click --text "Add to cart" --wait --task t && …`.
- `navigate --snapshot` to a URL the task already has open lists the reloaded page. It checked readiness after sending the reload, when the old document still read as complete, so it could list the page being replaced; Electron and Arc navigations had the same gap.
- `browser dialog accept` with no dialog open says so and succeeds; an unknown task is still an error. An `alert()` is accepted the moment it appears, so the answer an agent sent after it failed with `No dialog is waiting for an answer on this task.` and exit code 1.
- The skill says to write the task name out on each call (a `$T` variable made Claude Code ask before running the command) and to chain known steps with `--wait`.
- Starting a Firefox profile whose Firefox is not running no longer stops the browser service. While the new Firefox opened its port, every refused connection raised a second error nothing listened for, and the service exited: `browser start` printed `Connection closed before response` and only a second start, against the now-running Firefox, worked.

## 0.1.24

- Several agents that run `browser start` on the same browser at the same moment each keep their task. Before, every start that found no connection yet opened its own, the last one replaced the others, and the earlier agents' next command failed with `Task "…" not found`. In a benchmark of three agents sharing one browser, the first agent lost its task within two seconds of starting.

## 0.1.23

- A ref keeps naming its element when only a number in the element's label changes. After an add-to-cart turned "Cart, 1 items" into "Cart, 2 items", `click <ref>` refused the cart button with `could not be re-resolved`; it now clicks it and prints `Clicked (button "Cart, 1 items" now reads "Cart, 2 items")`. A label that changes otherwise ("Delete Alice" to "Delete Bob" on a recycled list row) is still refused.
- A page's `alert()` no longer freezes the task: it is accepted at once and the next command prints `The page showed alert "…"; it was accepted.` (one such alert on a shop hung every later command for 30–120 s). A leave-page prompt is accepted the same way. A `confirm()` or `prompt()` stays open: the `click` or `press` that raised it returns with the question, other commands on that task say the page is asking, and `browser dialog accept|dismiss [--text <reply>]` answers it.
- `browser start --url <url> --snapshot` prints the loaded page's refs after the task name, so the first action needs no separate `browser refs`.
- `browser click --text "Checkout"` (optionally `--role button`) clicks the element with that accessible name without listing the page first. When nothing matches, the error lists the elements that are there.
- `browser type` into a time, date, datetime, month, week, color or range input sets its value: `type 9 "7:45 PM"` prints `Typed (the input now reads "19:45")`. Before, it printed `Typed` and the field stayed empty. A value the input rejects is an error naming the format it takes, and `browser refs` lists the whole input as one ref.
- `browser click <ref>` on an option of a native `<select>` selects it. It used to fail with `Could not compute box model`.
- `browser refs` and `--snapshot` no longer wait for the task state file to be rewritten (4-7 ms per call); the listing cache is saved shortly after.
- The browser skill shows `start --snapshot`, `click --text`, `select`, `press` and `evaluate` in its workflow, so agents stop looking them up in `--help`.
- A browser verb sent to another device (`--device`, or a task bound there) stays fast after an agent pauses between turns. The shared ssh connection used to close after 2 idle minutes, so the next verb paid a fresh handshake (about 270 ms instead of 25 ms to a Tailscale peer); it now stays open for 30 idle minutes. A remote screenshot's copy-back reuses that connection too instead of opening its own.
- Remote verbs work again when `AGENTS_HOME` or `AGENTS_CACHE_DIR` is a long path. The ssh connection socket under it went past the 104-byte socket path limit and ssh failed every remote verb with `ControlPath too long`; such homes now keep their sockets in a short private folder under `$XDG_RUNTIME_DIR` or `/tmp`.
- `browser click <ref> --snapshot` on a link that changes the page without loading a new one (a single-page app's router, such as a shop's cart or checkout button) returns as soon as the router has drawn the new page, and lists that page's elements. Before, every such click waited out a 3-second timeout; in a checkout benchmark it was 6 of the 12 seconds browser-cli lost to agent-browser.
- Every `browser` command starts about 30 ms sooner after `npm install`. npm used to link `browser` to a Node script that then started the compiled binary; an install script now puts the binary itself in that place on macOS and Linux, so a command starts no Node process. The binary reads its skill from the package it was installed in. Windows, `npm install --ignore-scripts`, pnpm, yarn, and bun without `bun pm trust @phnx-labs/browser-cli` keep the Node launcher, which works as before.
- The compiled binary no longer decodes base64 strings or runs flattened control flow on every start, which cost each command and the background service 8 to 12 ms (`browser --version` went from 42 to 16 ms on one core). Its strings are now readable in the file; identifiers stay renamed and the code is still minified and compiled to bytecode.

## 0.1.22

- An Arc task opened in a window that is not in front keeps working. Making the first tab raised that window, and Arc reorders its window list when it does, so browser-cli read the new tab's window id back by position and recorded another window's id. Every later command on the task then failed with `Owned Arc tab "…" has no stable id in its original window/Space`, `stop` included, and the creation-marker tab `agents-browser.invalid/…` could stay in front. The driver now records the window and Space from the ids it looked up before making the tab, and finds the window again by id after. The service refuses to save a tab Arc reports in another window or Space.
- A headless browser on Linux loads web pages again on a machine whose desktop keyring is locked. Chromium encrypted its cookies through gnome-keyring, and on box-b and box-a, where nobody unlocks the login keyring, that call never returned. Every `http`/`https` page stalled before its request was sent, so `navigate`, `evaluate` and `screenshot` hung and the tab stayed on `about:blank`, while `data:` and `file:` pages worked. browser-cli now launches headless, non-Electron managed browsers on Linux with `--password-store=basic`. Headed browsers, a store you already use, and macOS and Windows are unchanged. A managed profile that ran headed on an unlocked keyring and now runs headless has to sign in again once.
- Releases wait for npm to show the five platform packages together, then publish the launcher, instead of waiting for six packages one after another. npm took 2 to 10 minutes per package, so 0.1.20 and 0.1.21 overran the 30-minute publish job after every package was published, and were cancelled before the tag push and install check. The job limit is also raised to 60 minutes as a backstop.

## 0.1.21

- `browser stop --service` works in a session with more than one browser task. It used to refuse with `Multiple browser tasks for this session — pass --task <name>`, and `--service` cannot be combined with `--task`, so the only way to load a new version's service code was to run it outside the agent session.
- `browser start --profile <name>` runs on this machine when this machine declares `<name>`, even when the fleet browser hub (`defaultBrowserDevice`) is another device. Since 0.1.16 started reading the synced `defaultBrowserDevice`, such a start was forwarded to the hub. The hub then tunnelled back for a debugging port that a pipe-launched browser never opens, and failed with `Browser profile "s1-desktop" is declared on box-b, but nothing is speaking CDP on port 9226`. Page commands that name such a profile with `--profile` and no task (`browser navigate --profile s1-desktop <url>`) stay here too. A profile declared both here and on the hub now runs here. A bare start, `--profile default`, and a profile declared only elsewhere still go to the hub.

## 0.1.20

- An Arc profile opens when more than one Arc window is visible. Every Arc window lists every Space, so the rule "use the Space open in exactly one visible window" failed for every Arc profile as soon as a second window was visible: `No Space of Arc profile "Work" is open in exactly one visible Arc window.` A task now opens in the frontmost visible window already showing one of the profile's Spaces, else the frontmost window and the profile's first Space. The task records that window, so later commands address the same one.

## 0.1.19

- In Chromium-family browsers, `browser refs` lists elements inside iframes, same-site and cross-site (one level below the page), under an `- iframe "<url>"` line, and `click`, `type`, `hover` and `select` act on them. `upload` into a cross-site iframe is refused with a pointer to the frame's URL. `hover` now numbers refs like `browser refs` does; before, `hover 7` could hover a different element than `refs` listed as 7. A cross-site frame's click goes to that frame's own session, so it lands even when the tab is not the one in front. Before, a quiz or form inside an iframe showed no refs and agents fell back to `evaluate`.
- `click` and `hover` scroll the element into view first. Before, a button below the fold printed `Clicked` and nothing happened.
- `browser text` prints the tab's title and URL, then the text a reader sees on the page and, in Chromium-family browsers, in each iframe.
- `browser select <ref> <option>` chooses a `<select>` option by its label or value and lists the options when none matches.
- `browser type <ref> <text>` takes the text positionally; `--text` still works.
- The browser skill teaches `--snapshot` on `click`, `type` and `press`, `browser text`, and chaining known steps in one shell call, instead of "run `refs` again after each action".

## 0.1.18

- `browser remote-control` help, its on/off confirmations and the refusal on a gated machine name the two real cross-machine paths, `browser start --device <device>` and `agents ssh <device> browser …`, instead of a `browser --device` that page verbs reject.

## 0.1.17

- The browser skill ships with the package at `skills/browser/` in the standard Agent Skills layout: `SKILL.md`, `references/arc.md`, `references/sites/<site>.md` (higgsfield, linkedin, perplexity, slack) and `scripts/slack/`. `browser skills path|list|get` reads the installed copy, and `npx skills add phnx-labs/browser-cli` installs it into agents.
- `browser help [command...] --json` prints the command tree with every argument, option, example and note, in the shape of `docs/command-index.json`. `browser help <command>` prints that command's help.
- `browser start --url` reads site guides from the installed skill instead of `~/.agents/skills/browser/domain-skills/` in each DotAgents layer, prints them under `--- site guide: <name> ---`, and reports `siteGuide` in `--json`. A missing skill prints a warning instead of silently showing no guide. A guide named after a bare TLD no longer matches every host.
- The `type` example in `browser --help` used a `--ref` flag that does not exist; it now shows `browser type 3 --text "hello"`.
- `--device` dispatch, streamed verbs and the screenshot copy now connect with the whole target an inherited context names: its user and its `sshArgs` (identity file, port, `HostName`, known-hosts) reach `ssh` and `scp` instead of being dropped, so a context-only device no longer falls through to a bare-alias connection. `screenshot -o <path>` on a remote task no longer forwards `-o`, so the hub saves under its own capture directory and the file is copied to the local path. A forwarded verb drops `--device` using the verb's own option arity, so a value such as `--text --device=x` and every word after `--` reach the remote unchanged, and an attached `-pPORT`/`-lUSER` in `sshArgs` reaches `scp` as `-PPORT`/`-oUser=USER`.
- Read and write the config keys agents-cli stores (`browserRemoteControl`, `defaultBrowserProfile`, `browserViewer`, `browserTaskIdleMinutes` in the device `config:`, and the central `defaultBrowserDevice` hub) instead of dotted names agents-cli never writes. Remote control turned on, a default profile picked or a hub set with `agents` now take effect in `browser`. The dotted spellings 0.1.16 and earlier wrote are still read, and setting a value replaces its dotted twin. Remote control stays off when the two spellings disagree.
- Add `scripts/generate-cli-docs.sh` with `--check` and `--out-dir`, downloadable command references in PR/release-branch CI, and a freshness check that also covers releases with tests/build skipped.

## 0.1.16

- The picker, the printed `browser sessions` listing, the format helpers and the
  stdout writers now come from the shared `@phnx-labs/tui` package, the same code
  `sessions` and `computer` use. The picker keeps its controls and
  still lists every row. Typing a filter now closes the preview, as in
  `sessions`; clear the filter and press space to reopen it.
- Relative ages read `just now` under a minute, `3 min ago`, `2 hours ago`,
  `4 days ago` and, past a week, the calendar date (`Sep 28`), instead of
  `11s ago`, `3m ago`, `2h ago`, `5d ago`.
- The printed `browser sessions` listing writes its count footer to stderr, so
  piped stdout carries rows only. It reads `Showing 50 of 120 tasks. --limit 120
  or --json to see all, --search or --since to narrow.` (`captures` and
  `--profile or --since to narrow` in the profile listing) instead of
  `… (70 more; --limit …)` on stdout, and a full listing reports its count
  (`12 tasks.`). The `--json` shapes are unchanged.

## 0.1.15

- `browser sessions` takes `--since <when>` / `--until <when>` (`2h`, `7d`, `4w`, `1mo`, `1y` or an ISO date, the same grammar as `sessions`) and `--limit <n>`, with the same semantics as `computer sessions`. The window applies to the picker, the printed listing and `--json`; an invalid value exits 2. The printed listing now stops at 50 rows by default and says how many it left out; `--json` stays unbounded unless `--limit` is given. The picker header names the active filters.
- Generate the command reference and Markdown/JSON indexes from the registered
  commands, including examples and notes. The test script rejects stale references
  after a help change; regenerate with `bun scripts/gen-docs.ts`.
- Browse browser tasks and captures interactively with search, previews, Enter and Escape. `browser sessions --json` keeps its existing per-profile capture shape; scripts that want task rows use `browser sessions --tasks --json`.
- Preserve browser task summaries for 365 days independently of Agents and Sessions, including finished tasks without captures; safely adopt existing Agents history.
- `browser use` with no name opens its profile picker again. In 0.1.13 and 0.1.14 it failed with `Cannot find package '@inquirer/prompts'`, because the release build obfuscated the package name the picker loads at run time.
- `browser profiles logins` found no login for Arc profiles, Comet's own
  profiles or any profile pinned to a user-data dir, because it only looked in
  the runtime dirs browser launches into. It now reads each profile's store
  where its browser keeps it: Arc's `User Data/<profile dir>`, Comet's
  user-data dir, a pinned `userDataDir`, an attach-only profile's durable dir.
  A store that cannot be read on this machine (declared on another device,
  reached over `ssh://`, Firefox, never launched here) is shown as
  `(not read: <reason>)` instead of `(none detected)`; `--json` adds one
  `{"profile", "service": null, "account": null, "unread"}` row for it. The
  `browser start` login warning no longer fires for such a profile, and
  `profiles show` now prints logins for Arc profiles.

## 0.1.14

- `browser profiles logins --json` prints a flat array with one
  `{"profile", "service", "account"}` row per detected login, so a script or
  agent hook can tell which profile is signed in to which service and as whom.
  `account` is `""` when no saved username matches. Profiles with no detected
  login emit no rows, and `[]` means nothing was found. Like the table, it
  reads cookie and username presence only and never prints a cookie or
  password value.

## 0.1.13

- Do not use 0.1.12. Its task cleanup decided whether an agent session was
  still running with a check that always answered "no", so it closed every
  agent's tabs within 5 minutes, including agents still using them. The check
  now looks for the session id on the process table (`--session-id <id>` on
  the agent's command line, or `AGENT_SESSION_ID` in its environment). When
  the table cannot be read, the session counts as alive. A task started from
  another machine with `--device` is closed only after it sits idle, since its
  session runs on that other machine. If a 0.1.12 service is running, upgrading
  does not replace it: run `browser stop --service` once after installing.
- On Arc, the first `evaluate` after `start` no longer times out. Arc does not
  run Apple Events JavaScript in a tab it has never shown, and `start` sends
  the new tab straight to the background, so that first call waited the full
  15 seconds and failed. `start` now runs one no-op while the tab is still in
  front (about 0.15 s); the first `evaluate` measured 1 s afterwards.
- `--device` runs every word of the forwarded command as text on the remote
  host. Arguments were JSON-quoted, which a remote shell still expands, so a
  value like `$(…)` ran there; the remote-control marker never reached the
  remote host either, so its consent check never fired. Page verbs other than
  `screenshot` ran on this machine instead of the named device.
- A stale `service.pid` can no longer get another process killed. After a
  crash or reboot the recorded pid may belong to an unrelated program, and a
  refused connect sent it SIGHUP, which terminates most processes. The pid
  now counts only while it is still `browser __serve`, it is written once the
  socket listens, and it is removed on a clean exit.
- Only one browser service runs per home. Two commands that both found no
  service each started one, and the second deleted the first's socket while
  both kept running.

## 0.1.12

- The browser service closes abandoned tasks again. agents-cli's daemon ran
  this every 5 minutes until `agents browser` became a client of this package;
  the standalone service never picked it up, so tasks whose agent had exited
  stayed open for weeks (88 on one Mac, 76 of them Arc). The pass runs at
  start and every 5 minutes, and `browser prune` now lists any task it could
  not close instead of stopping at the first one.
- Closing an Arc task whose tab creation was interrupted no longer finishes
  that creation first. It used to open a tab and load the task's page in your
  Arc only to close it, or refuse to close the task at all. A pending tab that
  still shows the task's page is closed; anything else is left alone.
- `browser status` and verbs that find your task without `--task` no longer
  wait on a saved profile that cannot be reached. One stale task for an
  `ssh://` profile on an offline host made every call wait about 8 seconds,
  longer than `status`'s 3-second limit. A slow failed reconnect is now retried
  after 5 minutes rather than on every call.

## 0.1.11

- Writes to `~/.agents/agents.yaml` now take a real lock, the one agents-cli
  uses (`proper-lockfile`). Earlier builds wrote a plain `agents.yaml.lock`
  file holding their PID and never removed it. That file was no lock at all,
  and agents-cli, which locks the same path as a directory, then failed with
  ENOTDIR on every attempt until its 30s timeout. On a Mac running the
  agents-cli daemon this stalled the daemon's event loop every tick, so the
  browser service it hosts stopped replying ("running but unresponsive",
  `browser status` hanging). The first write with this version removes a
  leftover file.

## 0.1.10

- One Arc row per Arc profile, like every other browser. An Arc row used to
  stand for a Space, so one Arc login could show up as several rows, and an
  untitled Space became `arc-space-<id>`. Now each row is one Arc profile (the
  thing that holds cookies and logins), and a task opens in the profile's first
  Space in sidebar order that is open in one Arc window. `status` still shows
  which Space a task is in. Saved rows keep their names.
- `browser profiles view <name>` replaces `profiles show`, matching `secrets
  view`. `show` still works.
- Discovered rows no longer write a generated `description` into your device
  config. The list shows your own note, or a label read from the browser
  (`Arc profile "Work"`) that never goes stale. `profiles view` prints
  `Description:` only for a note someone wrote.
- `browser profiles prune` removes saved rows that duplicate another row's
  login (`duplicate: same login as arc-work`), and never removes a saved row
  for a native browser profile just because it was never started. After
  upgrading, run `browser profiles prune --dry-run` once to see the leftover
  per-Space rows, then `browser profiles prune`. Clear an old generated
  description with `browser profiles edit <name> --description ''`.

## 0.1.9

- `press Enter` (and Space) submit forms. The key event carried no text, so
  Chromium never fired keypress and a form's implicit submission never
  happened: "type the query, press Enter" silently did nothing on every search
  box, in every earlier version. Verified against a real form; covered by the
  live test.
- `--snapshot` settles more accurately without penalizing the common case.
  It watches only the top frame (ad and live-example iframes navigate on their
  own schedule and made a same-page `type --snapshot` wait out the whole
  3-second load timeout on MDN's `<input>` reference); when nothing navigates
  it now returns as soon as the page is idle measured from the action, instead
  of always paying a fixed network + DOM floor (a static `type --snapshot`
  dropped from ~470ms to ~200ms). A full navigation started by the action (a
  link, a form submit) is waited for to load. A JS-deferred client-side (SPA)
  route change may commit after the settle window, so `--snapshot` captures it
  best-effort and can occasionally return the page mid-transition; use
  `browser wait --url` or `browser wait --selector` then `browser refs` when an
  agent needs certainty about a client-side navigation.

## 0.1.8

- Every hint, example and error message names the standalone `browser`
  command. Text extracted from agents-cli still told the reader to run
  `agents browser …`, `agents setup`, `agents secrets …`, `agents config set …`,
  `agents devices list` or `agents daemon restart`; those now read `browser use
  <name>`, `browser profiles create …`, `secrets create …`, `browser start
  --device <host>`, `~/.ssh/config`, and `browser stop --service`. HAR exports
  name `browser-cli` as their creator.

## 0.1.7

- A first browser action under a home whose socket directory does not exist
  yet (a fresh machine, an isolated `HOME`) started the service again. 0.1.6's
  connect-first client only treated `ENOENT` and `ECONNREFUSED` as "service not
  running"; Bun reports `EINVAL` for a socket path past the unix limit whose
  directory is missing, so such a cold start failed with `IPC error: connect
  EINVAL` instead of starting the service.

## 0.1.6

- `click` and `type` on a page whose `refs` listing is still current no longer
  rebuild the whole accessibility tree: one node check confirms the cached ref
  still points at the element the caller saw, and only a removed or changed
  element falls back to the rebuild-and-heal path. On a 400-field page a click
  went from ~415 ms to ~53 ms end to end.
- `refs` asks the page once whether any rich-text editor root exists before
  walking textboxes for editor detection. The walk cost three CDP round trips
  per textbox (~260 ms of a ~420 ms `refs` on a 400-field page); pages without
  an editor now skip it entirely, and pages with one are detected as before.
- The compressed screenshot captures at most twice (quality 60, then 30 when
  the first is over 100 KB) instead of up to five times. A capture costs the
  same 25-50 ms at any quality, so the ladder was paying for captures, not size.
- Every browser verb used to open four IPC connections before doing its work
  (reachability probe, responsiveness probe, a version request, then the
  request). It now sends the request first and only starts the service when
  the connect is refused; the daemon stamps its version on every reply so
  version skew is still noticed, and the wedged-daemon check runs
  only once a request has waited a full probe window without a reply.
- `navigate`, `click`, `type` and `press` take `--snapshot`: after the action
  settles they also print the page url, title and the interactive ref listing a
  following `refs` would print, so the next decision needs one command, not
  two or three.
- `BROWSER_TRACE=1` on the daemon logs per-request and per-CDP-call timings.
- `bun.lock` synced with the 0.1.5 optionalDependencies pins.

## 0.1.5

- Re-cut of 0.1.4 with no functional change. The 0.1.4 publish stalled partway —
  the two darwin platform binaries reached npm but the main package and the
  linux/win binaries did not, and because bun `--compile` binaries are not
  byte-reproducible, a fresh build can never match the already-published darwin
  bytes, so `scripts/release.sh`'s "verify existing" integrity check cannot
  complete the 0.1.4 publish. 0.1.5 publishes all six packages from one
  consistent build. The orphaned `@phnx-labs/browser-cli-darwin-*@0.1.4` platform
  packages are inert (no `@phnx-labs/browser-cli@0.1.4` main package references
  them). All 0.1.4 changes below ship unchanged in 0.1.5.

## 0.1.4

- `browser status` no longer goes blank when one Arc task is stale. A single Arc
  tab that had been moved to another window or Space — or closed — made `status`
  throw, and every profile vanished from the listing, including healthy ones. The
  refusal to adopt a moved tab is unchanged: an action still will not drive a tab
  its task no longer owns. Read-only `status` now reports the unreadable task with
  the tab count it owns on disk plus the reason its live tabs could not be read,
  lists an unreadable profile with an `unavailable` reason instead of dropping it,
  and reports the other profiles normally. `tabs` is absent rather than empty for
  such a task, so nothing claims a stale tab is live.
- `browser status` reads Arc once per pass instead of once per tab. A profile with
  many tasks paid one AppleScript round trip per owned tab, and each saved Arc
  runtime probed liveness separately while reconnecting, so a cold `status` spent
  dozens of serialized round trips before printing anything. It now takes a single
  snapshot and a single liveness read for the whole pass, shared across every Arc
  profile, and never contacts Arc when no Arc profile is present. Actions are
  unchanged and still read Arc live per tab.
- A saved profile that cannot be read during reconnection — a `tasks.json` left
  truncated by a crash, or an Arc call that fails — is reported with the reason
  instead of aborting the listing, so `running: false` never stands alone.

## 0.1.3

- Browser ownership metadata now follows successful task restoration. After an
  identity-checked attachment to a surviving browser's debugging port, the new
  service records its own process ID while preserving the original launch metadata.
- Private `--remote-debugging-pipe` handles cannot transfer between service
  processes. Coordinate release of an active pipe-connected browser before
  replacing its service; this release does not add pipe handoff.

## 0.1.2

- Focusing a Chrome tab now displays that tab, matching Arc and Firefox. A failed activation preserves the previously selected tab.

## 0.1.1

- Bound browser status requests to three seconds and report an unresponsive service as unknown, distinct from stopped.

## 0.1.0

First standalone release of `@phnx-labs/browser-cli`, extracted from the
`agents browser` subsystem of agents-cli.

- Drive Chromium-family browsers (Chrome, Brave, Edge, Chromium, Comet) over the
  Chrome DevTools Protocol, Firefox over WebDriver BiDi, and Arc over Apple
  Events on macOS.
- Manage browser processes, tasks, tabs and network capture through a local IPC
  service; keep a local action ledger and `browser sessions` history.
- Machine-local profiles with `cdp://`, `bidi=firefox-bidi://` and `ssh://`
  endpoints; bind a task to a remote device with `--device` on `start`.
- No runtime dependency on agents-cli. The inherited context descriptor, event
  stream and shared on-disk paths are the only seams (see docs/integration.md).
- Ship per-platform binaries (macOS arm64/x64, Linux arm64/x64, Windows x64) as
  optional dependencies behind a small Node launcher. The build minifies,
  obfuscates and bytecode-compiles the bundle; the npm tarball carries no
  TypeScript sources or source maps. `scripts/verify-compiled.mjs` gates each
  binary in CI.
