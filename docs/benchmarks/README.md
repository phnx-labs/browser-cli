# Benchmarks

How browser-cli compares with other browser tools for coding agents, measured as turns, wall time, tokens and cost per task. Every number on this page comes from a record in [`bench/results/2026-11-07/`](../../bench/results/2026-11-07/) or [`bench/results/2026-11-11/`](../../bench/results/2026-11-11/), and [`bench/`](../../bench/README.md) reruns it.

## 2026-11-11: several agents, one browser, with browser-cli 0.2.8

The same several-agents test as on 2026-11-07 below, rerun after 0.2.8 fixed slow clicks in background tabs. Same machine, Chrome for Testing 153.0.8010.36, Claude Sonnet 5.5 in Claude Code 2.1.301, and the same versions of the other three tools; browser-cli built from a3c0d29 (0.2.8). Two trials per tool, records in [`bench/results/2026-11-11/isolation/`](../../bench/results/2026-11-11/isolation/). Model spend reported by Claude Code: $2.15.

| Tool | Tasks solved | Runs that saw another agent's tab | Wall seconds per trial |
|---|---:|---:|---:|
| **browser-cli 0.2.8** | 6/6 | **0/6** | **16, 34** |
| browser-harness 0.1.13 | 6/6 | 5/6 | 42, 40 |
| Browser Use 0.13.14 | 6/6 | 4/6 | 42, 30 |
| agent-browser 0.41.2 | 6/6 | 6/6 | 126, 98 |

On 2026-11-07, browser-cli 0.2.3 took 86 and 80 s. Tasks open as tabs of one window, so with three agents two of the tabs are in the background, and Chrome holds each mouse move sent to a background tab for 5 s while it delivers a press at once. 0.2.3 moved the mouse twice before every click, so each click in a background tab waited 10 s: the pizza agent's one command of three typed fields and four clicks took 42 s. 0.2.8 presses without the moves in a background tab ([#62](https://github.com/phnx-labs/browser-cli/pull/62)), and the pizza agent now takes 12 and 27 s. browser-cli's second trial took 34 s because its saucedemo agent took 14 turns. Agents working alone were not affected, so the eight-task numbers below stand.

## 2026-11-07: browser-cli 0.2.3 against three tools

The README's chart and several-agents table. One machine, one session, with [`bench/`](../../bench) at b5779f7 (browser-cli 0.2.3) and the method in [`bench/README.md`](../../bench/README.md):

- Linux arm64, Chrome for Testing 153.0.8010.36, a fresh headless instance for every run.
- Claude Sonnet 5.5 in Claude Code 2.1.301, each tool with its own shipped skill.
- [browser-cli 0.2.3](https://www.npmjs.com/package/@phnx-labs/browser-cli/v/0.2.3) built from b5779f7, [Browser Use 0.13.14](https://pypi.org/project/browser-use/0.13.14/), [browser-harness 0.1.13](https://pypi.org/project/browser-harness/0.1.13/), [agent-browser 0.41.2](https://www.npmjs.com/package/agent-browser/v/0.41.2). Browserbase `browse` was not in this run.
- Two runs per task (64 suite runs) and two several-agents trials per tool (8 trials). Model spend reported by Claude Code: $5.94.

Every run's record is in [`bench/results/2026-11-07/`](../../bench/results/2026-11-07/), with `summary.md` as `bun bench/run.ts summary` printed it. Local paths are replaced with `~` and `<run>`, and the `skills`, `plugins` and `tools` lists are left out because they list the runner's own Claude Code install: every run, for every tool, loaded 20 skills (the tool's own, listed first, and 19 others) and 3 plugins. Transcripts are not included.

### The eight tasks

Each agent got one of these prompts. The exact wording of every prompt is in [`bench/tasks.json`](../../bench/tasks.json).

| Task | Site | What the agent was asked |
| --- | --- | --- |
| books | [Books to Scrape](https://books.toscrape.com) | Find the cheapest five-star book in the Mystery category, across every page, and give its title and price |
| pizza | [httpbin forms](https://httpbin.org/forms/post) | Fill in and submit a pizza order: name, phone, email, size Large, two toppings, delivery time 19:45, instructions |
| bun | [GitHub](https://github.com/oven-sh/bun/releases) | Open Bun's latest release and give its tag, its number of assets and the size of `bun-linux-x64.zip` |
| saucedemo | [Sauce Demo](https://www.saucedemo.com) | Log in, sort by price, add two named products to the cart and check out until the order is complete |
| laptops | [Web Scraper test site](https://webscraper.io/test-sites/e-commerce/static/computers/laptops) | Look through every page of laptops and give the most expensive one's name and price |
| demoblaze | [Demoblaze](https://www.demoblaze.com) | Add two named phones to the cart, place the order with test details, and give the order's Id and amount |
| instagram | [Instagram](https://www.instagram.com/nasa/) | Open NASA's public profile and give the account's name and follower count |
| wikipedia | [Wikipedia](https://en.wikipedia.org) | Find which country won the 2022 FIFA World Cup, then give the population of its capital |

### Eight graded web tasks

| Tool | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---:|---:|---:|---:|---:|
| **browser-cli 0.2.3** | 16/16 | 5.88 | **17.1** | 89k | **$0.0472** |
| browser-harness 0.1.13 | 16/16 | **5.56** | 20.4 | **82k** | $0.0502 |
| Browser Use 0.13.14 | 16/16 | 5.69 | 19.7 | 91k | $0.0584 |
| agent-browser 0.41.2 | 16/16 | 14.75 | 35.8 | 267k | $0.0970 |

browser-cli is fastest and cheapest; browser-harness takes the fewest turns and tokens. Claude Code refused 36 of agent-browser's commands in the 16 runs and none of the other tools'. 16 of them were its skill's `S=$(agent-browser session id --scope worktree --prefix task)` line and most of the rest other shell assignments and pipes, which the benchmark's allow rule (only the tool's own command in Bash) does not admit, so part of agent-browser's turns is that rule rather than the tool.

Per task, both runs correct for every tool; mean turns and seconds:

| Task | browser-cli | browser-harness | Browser Use | agent-browser |
|---|---|---|---|---|
| books (cheapest Mystery book) | 5.0 turns, 14 s | 4.0 turns, 12 s | 4.5 turns, 13 s | 8.5 turns, 22 s |
| pizza (order form) | 5.0 turns, 14 s | 5.0 turns, 15 s | 5.0 turns, 13 s | 12.5 turns, 27 s |
| bun (GitHub release) | 4.0 turns, 11 s | 8.0 turns, 28 s | 6.5 turns, 22 s | 14.5 turns, 37 s |
| saucedemo (log in and check out) | 6.0 turns, 20 s | 6.5 turns, 25 s | 7.0 turns, 24 s | 25.5 turns, 71 s |
| laptops (most expensive laptop) | 5.5 turns, 18 s | 5.0 turns, 20 s | 5.5 turns, 21 s | 22.5 turns, 46 s |
| demoblaze (place an order) | 9.0 turns, 30 s | 6.5 turns, 34 s | 7.5 turns, 40 s | 16.5 turns, 44 s |
| instagram (profile followers) | 4.5 turns, 10 s | 4.0 turns, 16 s | 4.5 turns, 12 s | 8.0 turns, 18 s |
| wikipedia (World Cup capital) | 8.0 turns, 20 s | 5.5 turns, 14 s | 5.0 turns, 13 s | 10.0 turns, 22 s |

### Several agents, one browser

Three Claude Code agents at once in one browser (books, pizza, saucedemo), each told "Work only in tabs you opened yourself", two trials per tool. A run saw another agent's tab when another agent's host or page title appeared in its tool output; each record's `leakingCommands` lists the commands and what they showed.

| Tool | Tasks solved | Runs that saw another agent's tab | Wall seconds per trial |
|---|---:|---:|---:|
| **browser-cli 0.2.3** | 6/6 | **0/6** | 86, 80 |
| browser-harness 0.1.13 | 6/6 | 6/6 | 28, 26 |
| Browser Use 0.13.14 | 6/6 | 4/6 | 30, 38 |
| agent-browser 0.41.2 | 6/6 | 6/6 | 64, 44 |

browser-harness and Browser Use showed other agents' tabs mostly through `list_tabs()`, agent-browser through `tab` and `snapshot`, with each agent on its own `--session`. browser-cli kept each agent to its own tabs in 4 to 6 turns, about what each task takes alone. Its trials took longer in wall time: the saucedemo agent took 80 and 86 s at 6 turns, against 20 s alone, and the pizza agent 54 and 55 s against 14 s. The cause was slow clicks in background tabs, fixed in 0.2.8; see the 2026-11-11 rerun above.

## How it compares

The comparison of browser-cli with other tools comes from reading each tool's own docs and source, not from runs: [How it compares](../comparison.md), with a source link in every cell, pinned to the commit read on 2026-11-07 (Claude in Chrome's docs are live pages, quoted as of that day).

Earlier runs, from 2026-10-19, used a script that is not in this repository: [archive](archive-2026-10-19.md).
