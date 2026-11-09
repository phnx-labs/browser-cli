# Getting started

browser-cli is one command, `browser`, that an agent runs from its shell to drive Chromium-family browsers, Firefox and Arc.

## Install

```sh
npm install -g @phnx-labs/browser-cli          # needs Node 22.5 or newer
npx skills add phnx-labs/browser-cli           # teaches your agents to use it
browser profiles create work --browser chrome  # chrome, brave, edge, chromium, comet, arc or custom
browser use work
```

In Claude Code the skill also installs as a plugin: `/plugin marketplace add phnx-labs/browser-cli`, then `/plugin install browser@browser-cli`.

## First run

```sh
browser start --url https://example.com --snapshot   # prints the task name, then the page
browser screenshot -o shot.png
browser done
```

`start` launches (or attaches to) the browser for a profile and opens a **task**: a browsing context with its own tabs and captures. Page commands such as `navigate` and `screenshot` act on the caller's live task, or on the one `--task <name>` names, and open a task when there is none. `done` closes the task's tabs. `browser stop --service` stops the background service.

Supported browsers:

- Chrome, Brave, Edge, Chromium and Comet over the Chrome DevTools Protocol
- Firefox 129 and newer over WebDriver BiDi
- Arc on macOS, through Apple Events; a task opens in an Arc window of its own

Run `browser --help` for every command and `browser <command> --help` for its options. The [command reference](../command-index.md) lists them all.

Next: [Driving a page](driving-a-page.md), [Profiles](profiles.md).
