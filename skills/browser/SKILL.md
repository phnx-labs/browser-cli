---
name: browser
description: Drive the user's real browser from the command line with the `browser` CLI — open sites they are signed into, navigate, click, type, read pages, take screenshots, capture console and network traffic, and show pages to the user. Use for any task that needs a website or web app, including logged-in sites, form filling, scraping, testing a web app, and opening a report or page for the user to look at.
allowed-tools: Bash(browser:*)
---

# browser

`browser` drives real browsers (Chrome-family over CDP, Firefox over BiDi, Arc natively) with the user's own profiles, cookies and logins.

## Use the user's browser

Start without `--profile` or `--device`:

```bash
browser start --url https://example.com
```

A bare start opens the browser the user configured as their default. When the machine is set to drive another device's browser, the start runs there. `browser use` prints the default. Pass `--profile` or `--device` only when the user or your instructions name one.

Do not create profiles, launch a headless browser, or switch to another machine's browser to work around an error. Sites block remote and cloud browsers, and those browsers do not have the user's logins. Report the error instead.

Never switch to a different browser because the default cannot do something. When it cannot do a step yet (Arc has no `console` capture, say), read the page as text and say a picture or capture was not possible. Never pick another profile from `browser profiles list` to get around it.

## Workflow

```bash
browser start --url https://example.com --snapshot   # the page's refs; later calls drive this task
browser click 3 --snapshot                           # act, then print the page it left
browser click --text "Checkout" --snapshot           # by visible name, no listing needed
browser type 5 "hello"                               # date/time inputs take "19:45" or "2026-10-18"
browser type "Email" "ada@example.com"               # or name the field by its label
browser select 7 "Large" --snapshot                  # a <select> option, by label or value
browser select "Sort" "Price (low to high)"          # the <select> named by its label
browser press Enter --snapshot
browser dialog accept                                # or dismiss: answers a confirm() or prompt() the page asked
browser refs                                         # interactive elements, numbered, iframes included
browser text                                         # title, URL and the page's readable text
browser text --grep "Total|Tax"                      # only the matching lines
browser text --css ".product"                        # each match's text, one block per match
browser text --css ".product a" --attr href          # or each match's attribute; no script needed
browser evaluate "document.title"                    # JavaScript, when the page text is not enough
browser evaluate --file - <<'JS'                     # read other pages: one expression on stdin
const base = '/catalogue/'; const urls = ['page-1.html', 'page-2.html'];
Promise.all(urls.map((p) => fetch(base + p).then((r) => r.text()))).then((pages) => pages.map((html) => new DOMParser().parseFromString(html, 'text/html').title))
JS
browser done                                         # close the task's tabs
```

Waiting, screenshots, console and network capture are in `browser --help`. `browser screenshot -o shots/step_001.png` creates the folder.

- Later calls drive the task your `start` opened; there is no id to pass. Pass `--task <name>` only to drive a second task you started, or on every call when your harness puts no session id in the shell's environment (Claude Code and Codex do).
- Every action returns once the page has settled: a navigation has loaded and drawn, a router has rendered, or nothing happened. The next command sees the page the action led to, so never `sleep`.
- Chain the steps you already know into one shell call with `&&`, and end it with what you need to see. Name elements by their labels when you know them, so a whole form or checkout goes in one call without a listing: `browser type "Username" ada && browser type "Password" secret && browser click --text "Login" --snapshot`. Use `--snapshot` on the last action for the refs, or `browser text` for the words: `browser start --url https://shop.example/p/1 && browser click --text "Add to cart" && browser text --grep Total`. When the next step depends on what the page shows, act once with `--snapshot` and look first.
- A ref keeps naming its element while that element is on the page, even when a count in its label changes ("Cart, empty" to "Cart, 2 items"). A new listing (`refs` or `--snapshot`) renumbers, so act on the numbers from the latest one.
- Alerts and leave-page prompts are accepted for you and printed. A confirm() or prompt() waits: the action that raised it prints the question, and you answer with `browser dialog accept` or `browser dialog dismiss`.
- Read the page without a script first. `browser text --css <selector>` lists each match (a product card, a table row, a search result) and `--attr href` its links; `browser text --grep <pattern>` prints only the matching lines, two lines around each (`--context <n>`), and a miss just says so. Write an `evaluate` script only for what those cannot do, such as fetching other pages. Keep the filtering inside `browser`: a pipe into `grep`, `python` or `jq` can need approval where only `browser` commands are allowed.
- Claude Code refuses a shell command, heredoc included, that has a quote anywhere inside `{…}` or a `\u00a0`-style escape. In `evaluate` scripts, return arrays (`[title, price]`) rather than objects, put strings in variables before any braces (`const sel = 'td'; [...document.querySelectorAll(sel)].map((r) => ({t: r.textContent}))`), use expression bodies instead of `{ return … }` (so `Promise.all(urls.map(…)).then(…)`, not an `async` function or a loop), and match spaces with `/\s/`, which covers no-break spaces.
- `browser start --url` prints the site guide for that site when one exists (`--- site guide: … ---`). Read it before you click.

## Flags: read the help, never guess

```bash
browser <command> --help      # options for one command
browser help --json           # every command, argument and option
```

An `unknown option` error means the flag does not exist. Read that command's `--help`.

## Show the user a page

A local file you only need to check, such as a page you rendered, is not for `show`: inspect it headlessly on your own machine (`browser start --device local --url file:///abs/path.html`, then `browser screenshot`), which opens nothing on the user's screen.

```bash
browser show https://example.com
browser show ./report.html
```

`show` opens it in the user's configured viewer and binds no task; on a box whose `browser.device` hub is another machine it copies a local file there and shows it on the hub, where the user is. It exits 1 with the reason when the viewer did not confirm the page; tell the user rather than retrying. After you update the page, run the same `show` again: it reloads and focuses the tab already showing it instead of opening another (`--fresh` forces a new tab). A tab a task opened with `browser start` is never reused. Add `--json` to see which browser opened it and whether the tab was `reused`.

## Arc

When the task's profile is an Arc profile, read `references/arc.md` first. Arc runs only synchronous JavaScript. The agent's tabs open in a separate Arc window of their own, and `browser screenshot` captures that window without bringing Arc forward.

## Editor windows

Each open VS Code or VSCodium window running the Agents extension is a profile in `browser profiles list`, named after the editor and its folder (`vscodium-my-app`, labeled `VSCodium window "my-app"`). Its pages open as tabs in that editor, next to the user's work, so the user can watch or do a step only a person can, such as a captcha. Use one only when the user or your instructions name it: `browser start --profile vscodium-my-app --url …`. Its tabs are the agent's own: they never include tabs the user opened in the editor. "The editor window … is no longer open" means that window closed or reloaded; run `browser profiles list` again.

## When something fails

- `browser status` lists the service and running tasks.
- Service unresponsive, or IPC requests time out: `browser stop --service`, then retry the command.
- `nothing is speaking CDP on port …`: that profile's browser is not running. Tell the user; do not switch browsers.
- `Task "…" not found`: the task ended. Start a new one.

## Reference documents

```bash
browser skills list            # this skill's documents
browser skills get arc         # references/arc.md
browser skills get slack       # a site guide, references/sites/slack.md
```

- `references/arc.md`: Arc limits and how to share the user's window safely.
- `references/sites/<site>.md`: per-site selectors and gotchas (higgsfield, linkedin, perplexity, slack).
- `scripts/slack/*.js`: page scripts for `browser evaluate --file`, used by the Slack guide.
