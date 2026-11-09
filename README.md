<div align="center">

# browser-cli

**Run several coding agents in your own signed-in browser at once. Each one works in its own tabs.**<br>
Chrome, Arc, Brave, Edge, Comet or Firefox, on this machine or another one over SSH.

[![npm](https://img.shields.io/npm/v/@phnx-labs/browser-cli?style=flat-square&color=C9A962&labelColor=0d1117)](https://www.npmjs.com/package/@phnx-labs/browser-cli)
[![CI](https://img.shields.io/github/actions/workflow/status/phnx-labs/browser-cli/test.yml?branch=main&style=flat-square&label=tests&labelColor=0d1117)](https://github.com/phnx-labs/browser-cli/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-555?style=flat-square&labelColor=0d1117)](LICENSE)

[Install](#install) · [Features](#features) · [Remote browsers](#remote-browsers) · [Benchmark](#benchmark) · [How it compares](#how-it-compares) · [Docs](#docs)

[phoenix.so/browser-cli](https://phoenix.so/browser-cli?ref=github) · [Why we open-sourced it](https://phoenix.so/blog/browser-cli?ref=github)

</div>

`browser` is one command an agent calls from its shell to drive the Chrome, Arc, Brave, Edge, Comet or Firefox profile you already use, on this machine or on another one over SSH. Every `browser start` opens a task that owns its tabs, so Claude Code, Codex and Cursor can work in the same signed-in browser at once without reading, typing into or closing each other's pages.

<p align="center">
  <img src="docs/assets/three-agents.gif" alt="Three Claude Code agents work at once in one Brave window, each in its own tab: one finds the cheapest mystery book, one fills a pizza order form, one checks out two items. Each pane shows the agent's current browser command, then its answer." width="100%">
  <br><sub>A real run on 2026-10-19, shown at 2×: three Claude Code agents, one browser, each in the tab its task owns.</sub>
</p>

## Install

```sh
npm install -g @phnx-labs/browser-cli
npx skills add phnx-labs/browser-cli              # teaches your agents to use it
browser profiles create work --browser chrome     # once: chrome, brave, edge, chromium, comet or arc
browser use work
```

Firefox connects through a WebDriver BiDi endpoint ([profiles](docs/guide/profiles.md)). npm needs Node 22.5 or newer; `browser` itself is a compiled binary for macOS, Linux and Windows. In Claude Code the skill also installs as a plugin: `/plugin marketplace add phnx-labs/browser-cli`, then `/plugin install browser@browser-cli`.

Or let your agent set it up. Paste this into Claude Code, Codex, Cursor or any agent with a shell:

```text
Set up browser-cli so you can use my web browser: https://github.com/phnx-labs/browser-cli

1. Install the CLI: npm install -g @phnx-labs/browser-cli (needs Node 22.5 or newer), then check it with: browser --version
2. Install its skill once, the way that fits you:
   - Claude Code: claude plugin marketplace add phnx-labs/browser-cli, then claude plugin install browser@browser-cli
   - Codex, Cursor, OpenCode or another agent: npx skills add phnx-labs/browser-cli -g -y -a <your agent's name, such as codex or cursor>
   Then read the skill now, before you use the browser: browser skills get
3. Set up the browser profile I asked for (this one setup step is the exception to the skill's rule against creating profiles): browser profiles create work --browser chrome, or brave or edge if I use one of those, then: browser use work. That profile starts signed out, so tell me I can sign in once, in the window it opens, to the sites I want you to use. If I use Arc, create it with --browser arc; for Comet add --attach-only. Both attach to the browser I already have open and signed in.
4. Try it: browser start --url https://news.ycombinator.com --snapshot, then browser done. Tell me the title of the top story.

Run browser <command> --help before guessing at a flag.
```

## Quick start

```console
$ browser start --url https://example.com --snapshot
readme-qs

Example Domain — https://example.com/
- link "Learn more" [ref=1]

$ browser click 1 --snapshot
Clicked

Example Domains — https://www.iana.org/help/example-domains
- link [ref=1]
- link "Domains" [ref=2]
- link "Protocols" [ref=3]
...

$ browser done
Completed task: readme-qs
```

Captured in Arc. In Chromium-family browsers `click --text "Learn more"` also clicks by name, and every action returns once the page has settled; everywhere, `--snapshot` prints the page it left, so an agent chains known steps in one shell call. Refs, `type`, `select`, dialogs, iframes and the rest are in [Driving a page](docs/guide/driving-a-page.md); every flag is in the [command reference](docs/command-index.md).

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Set up in a minute

Install the CLI and its skill, create a profile for the browser you already use, and the first page with its clickable elements is one command away.

[Docs →](docs/use-cases/set-up-in-a-minute.md)

</td>
<td width="50%">
  <a href="docs/use-cases/set-up-in-a-minute.md"><picture><source srcset="docs/assets/readme-features/set-up-in-a-minute.webp" type="image/webp"><img src="docs/assets/readme-features/set-up-in-a-minute.poster.jpg" alt="A terminal creates a Brave profile, makes it the default, opens Hacker News with its elements listed and clicks "new"" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Keep work and personal apart

Each profile has its own logins. Sign in once in the profile an agent uses, and your other profiles never share that session.

[Docs →](docs/use-cases/work-and-personal-profiles.md)

</td>
<td width="50%">
  <a href="docs/use-cases/work-and-personal-profiles.md"><picture><source srcset="docs/assets/readme-features/work-and-personal-profiles.webp" type="image/webp"><img src="docs/assets/readme-features/work-and-personal-profiles.poster.jpg" alt="After signing in on the work profile, the same secure page opens for work and sends personal to the login page" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Research papers and sources

Search, open the source and pull out the numbers that matter. `text --grep` and `text --css` keep a long paper to a few lines.

[Docs →](docs/use-cases/research.md)

</td>
<td width="50%">
  <a href="docs/use-cases/research.md"><picture><source srcset="docs/assets/readme-features/research.webp" type="image/webp"><img src="docs/assets/readme-features/research.poster.jpg" alt="An agent searches arXiv, opens a 2026 paper on web-browsing agents and reads its headline result" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Check a page on a phone

Emulate an iPhone, iPad or any viewport, reload and screenshot, to check the layout your users see.

[Docs →](docs/use-cases/check-on-a-phone.md)

</td>
<td width="50%">
  <a href="docs/use-cases/check-on-a-phone.md"><picture><source srcset="docs/assets/readme-features/check-on-a-phone.webp" type="image/webp"><img src="docs/assets/readme-features/check-on-a-phone.poster.jpg" alt="Books to Scrape switches from its desktop layout to the iPhone 14 layout" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Download files

Pick a folder, click the link and wait until the file is on disk, then open it. The agent gets the real path back.

[Docs →](docs/use-cases/download-files.md)

</td>
<td width="50%">
  <a href="docs/use-cases/download-files.md"><picture><source srcset="docs/assets/readme-features/download-files.webp" type="image/webp"><img src="docs/assets/readme-features/download-files.poster.jpg" alt="An agent downloads a full-size photo from Unsplash, opens the file and describes it" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Keep proof of what it did

Recordings, PDFs and screenshots are saved per task, and `browser sessions` lists them, so you can check the work.

[Docs →](docs/use-cases/keep-proof.md)

</td>
<td width="50%">
  <a href="docs/use-cases/keep-proof.md"><picture><source srcset="docs/assets/readme-features/keep-proof.webp" type="image/webp"><img src="docs/assets/readme-features/keep-proof.poster.jpg" alt="An agent records itself on a GitHub release page, saves a PDF and a screenshot, then opens the PDF" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Fill forms and check out

Type into fields by their label, pick options and click by name. Each action waits for the page to settle, so steps chain.

[Docs →](docs/use-cases/fill-forms-and-check-out.md)

</td>
<td width="50%">
  <a href="docs/use-cases/fill-forms-and-check-out.md"><picture><source srcset="docs/assets/readme-features/fill-forms-and-check-out.webp" type="image/webp"><img src="docs/assets/readme-features/fill-forms-and-check-out.poster.jpg" alt="An agent logs in to Sauce Demo, adds the two cheapest items and completes the order" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Use the sites you are signed into

Sign in once and your agent works in that session: HR, CRM and admin tools, including ones with no API or MCP server.

[Docs →](docs/use-cases/signed-in-sites.md)

</td>
<td width="50%">
  <a href="docs/use-cases/signed-in-sites.md"><picture><source srcset="docs/assets/readme-features/signed-in-sites.webp" type="image/webp"><img src="docs/assets/readme-features/signed-in-sites.poster.jpg" alt="An agent adds an employee in an HR system the browser was already signed into" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Several agents, one browser

Every `browser start` opens a task that owns its tabs, so several agents share one signed-in browser without touching each other's pages.

[Docs →](docs/use-cases/several-agents.md)

</td>
<td width="50%">
  <a href="docs/use-cases/several-agents.md"><picture><source srcset="docs/assets/readme-features/several-agents.webp" type="image/webp"><img src="docs/assets/readme-features/several-agents.poster.jpg" alt="Three Claude Code agents work at once in one Brave window, each in its own tab" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Design in Figma

In canvas apps the agent works the way a person does: shortcuts, clicks at a position, and the properties panel by label.

[Docs →](docs/use-cases/design-in-figma.md)

</td>
<td width="50%">
  <a href="docs/use-cases/design-in-figma.md"><picture><source srcset="docs/assets/readme-features/design-in-figma.webp" type="image/webp"><img src="docs/assets/readme-features/design-in-figma.poster.jpg" alt="An agent builds an Apple-style mobile landing page in Figma" width="100%" /></picture></a>
</td>
</tr>
</table>

Each clip is a real run recorded with browser-cli, sped up; the page for each shows the task, the commands and what came back.

## Remote browsers

Drive the browser on another machine over SSH. Turn it on once on that machine with `browser remote-control on` (it is off by default), then:

```sh
browser start --device box --profile work    # box is a Host in ~/.ssh/config
browser navigate https://example.com         # later commands follow the task there
```

Chromium-family browsers only; Firefox and Arc run on the local machine. More in [Remote browsers](docs/guide/remote.md).

## Benchmark

Four browser tools on eight web tasks, Claude Sonnet 5.5 in Claude Code, 2 runs per task, 2026-11-07:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/benchmark-dark.svg">
  <img src="docs/assets/benchmark-light.svg" alt="Turns, seconds and tokens per task for browser-cli and three other browser tools over 8 tasks on 2026-11-07; browser-cli is fastest at 17.1 s, browser-harness takes the fewest turns (5.6) and tokens (82k)" width="100%">
</picture>

- **Fastest and cheapest:** browser-cli 0.2.3 took 17.1 s and $0.047 per task, against 19.7 s and $0.058 for Browser Use and 20.4 s and $0.050 for browser-harness.
- **Fewest turns and tokens:** browser-harness, at 5.6 turns and 82k tokens per task; browser-cli took 5.9 and 89k.
- **Every tool answered all 16 runs correctly.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/crossed-tabs-dark.svg">
  <img src="docs/assets/crossed-tabs-light.svg" alt="Runs where an agent saw another agent's tab, out of 6: browser-cli 0, browser-harness 6, Browser Use 4, agent-browser 6" width="100%">
</picture>

- **No agent saw another's tabs with browser-cli** when three agents worked in one browser at once.

Method, per-task results and the run records: [Benchmarks](docs/benchmarks/README.md). Rerun it with [`bench/`](bench/README.md).

## How it compares

| Tool | Several agents in one browser | Another machine | Your signed-in browser |
| --- | --- | --- | --- |
| **browser-cli** | [Each task owns its tabs](docs/use-cases/several-agents.md) | [Over SSH](docs/guide/remote.md) | [Yes, any profile](docs/guide/profiles.md) |
| [browser-harness](https://github.com/browser-use/browser-harness) | [One current tab; agents can race](https://github.com/browser-use/browser-harness/blob/b41bfb643e6c0f5a879b389615dcd1ee8c6bc165/SKILL.md?plain=1#L67-L80) | [Any CDP URL](https://github.com/browser-use/browser-harness/blob/b41bfb643e6c0f5a879b389615dcd1ee8c6bc165/src/browser_harness/daemon.py#L264-L270) | [Yes, after Chrome's Allow dialog](https://github.com/browser-use/browser-harness/blob/b41bfb643e6c0f5a879b389615dcd1ee8c6bc165/README.md?plain=1#L50) |
| [agent-browser](https://agent-browser.dev) | [A browser per session, or opt-in `--pin-tab`](https://github.com/vercel-labs/agent-browser/blob/d44f6989bf5e9a9a1c6dd6d97175f8c33b138eca/docs/content/docs/sessions.mdx?plain=1#L73-L84) | [Any CDP URL](https://github.com/vercel-labs/agent-browser/blob/d44f6989bf5e9a9a1c6dd6d97175f8c33b138eca/docs/content/docs/cdp-mode.mdx?plain=1#L25-L34) | [Copies or attaches to your profile](https://github.com/vercel-labs/agent-browser/blob/d44f6989bf5e9a9a1c6dd6d97175f8c33b138eca/docs/content/docs/sessions.mdx?plain=1#L88) |
| [Browserbase `browse`](https://github.com/browserbase/stagehand/tree/main/packages/cli) | [A browser per session](https://github.com/browserbase/stagehand/blob/310957518a931c1a84c5968b13282cc30acd1be9/packages/cli/README.md?plain=1#L48) | [Any CDP URL](https://github.com/browserbase/stagehand/blob/310957518a931c1a84c5968b13282cc30acd1be9/packages/cli/README.md?plain=1#L62) | [`--auto-connect` to local Chrome](https://github.com/browserbase/stagehand/blob/310957518a931c1a84c5968b13282cc30acd1be9/packages/cli/README.md?plain=1#L61) |
| [Playwright CLI](https://github.com/microsoft/playwright-cli) | [A browser per session](https://github.com/microsoft/playwright-cli/blob/4bc00fb7fa5b4329f2fb53ac4743a066c2c664e8/skills/playwright-cli/references/session-management.md?plain=1#L22-L30) | [CDP URL or Playwright server](https://github.com/microsoft/playwright-cli/blob/4bc00fb7fa5b4329f2fb53ac4743a066c2c664e8/README.md?plain=1#L488-L505) | [After Chrome's toggle, or the extension](https://github.com/microsoft/playwright-cli/blob/4bc00fb7fa5b4329f2fb53ac4743a066c2c664e8/skills/playwright-cli/references/session-management.md?plain=1#L116) |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | [A tab group per client (extension)](https://github.com/microsoft/playwright/blob/07c7069cdbb1f5c7331d3f4d2abd864dcfde745a/packages/extension/README.md?plain=1#L41-L43) | [CDP URL or Playwright server](https://github.com/microsoft/playwright-mcp/blob/404be8eb89abecff77a55152b6d843d140c78372/README.md?plain=1#L416-L417) | [Through the extension](https://github.com/microsoft/playwright/blob/07c7069cdbb1f5c7331d3f4d2abd864dcfde745a/packages/extension/README.md?plain=1#L5) |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | [Any session can close any page](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/0b37364dc0a88a804c6d73d3335e776adc7f33c4/src/McpContext.ts#L606-L613) | [Any CDP URL](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/0b37364dc0a88a804c6d73d3335e776adc7f33c4/docs/configuration.md?plain=1#L72-L81) | [After an Allow dialog, Chrome 144+](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/0b37364dc0a88a804c6d73d3335e776adc7f33c4/docs/configuration.md?plain=1#L67-L68) |
| [Claude in Chrome](https://code.claude.com/docs/en/chrome) | [A tab group per session](https://code.claude.com/docs/en/chrome) | Not documented | [Yes, through the extension](https://code.claude.com/docs/en/chrome) |
| [Playwriter](https://playwriter.dev) | [Tabs shared across sessions](https://github.com/remorses/playwriter/blob/2cae912a9c1e68ae2b74fcaef9efd79b6d7d432f/website/src/pages/docs/sessions.mdx?plain=1#L46-L48) | [`playwriter serve` over a LAN or tunnel](https://github.com/remorses/playwriter/blob/2cae912a9c1e68ae2b74fcaef9efd79b6d7d432f/README.md?plain=1#L345-L363) | [Yes, through the extension](https://github.com/remorses/playwriter/blob/2cae912a9c1e68ae2b74fcaef9efd79b6d7d432f/README.md?plain=1#L299) |

Each cell links to the line in that tool's own docs or code it comes from, read on 2026-11-07; the same table is in [docs/comparison.md](docs/comparison.md).

## Security and privacy

- **An agent with `browser` acts as you.** It can read and click anything your signed-in profile can. Give it a dedicated profile when it should not see your personal accounts. There is no URL allowlist yet.
- **Nothing leaves your machine.** No telemetry. The one exception: the first recording on a machine without ffmpeg installs it.
- **Remote control is off by default.** Another machine can drive this browser only after `browser remote-control on`.

Details: [SECURITY.md](SECURITY.md).

## Docs

| For | Read |
| --- | --- |
| **Start** | [Getting started](docs/guide/getting-started.md) · [Command reference](docs/command-index.md) |
| **Use cases** | [All ten, with recorded runs](docs/use-cases/README.md) |
| **Guide** | [Driving a page](docs/guide/driving-a-page.md) · [Profiles](docs/guide/profiles.md) · [Remote browsers](docs/guide/remote.md) · [Agent skill](docs/guide/agent-skill.md) · [Troubleshooting](docs/guide/troubleshooting.md) · [History and logs](docs/guide/history-and-logs.md) |
| **Benchmarks** | [Results](docs/benchmarks/README.md) · [How it compares](docs/comparison.md) · [Rerun with `bench/`](bench/README.md) |
| **Contributing** | [Development](docs/development.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

browser-cli is built by [Phoenix](https://phoenix.so/browser-cli?ref=github) ([why we open-sourced it](https://phoenix.so/blog/browser-cli?ref=github)). Apache-2.0.
