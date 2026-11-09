# Benchmarks

How browser-cli compares with other browser tools for coding agents, measured as turns, wall time, tokens and cost per task. Every number on this page comes from a record in [`bench/results/2026-11-07/`](../../bench/results/2026-11-07/), and [`bench/`](../../bench/README.md) reruns it.

## 2026-11-07: browser-cli 0.2.3 against three tools

The README's chart and several-agents table. One machine, one session, with [`bench/`](../../bench) at b5779f7 (browser-cli 0.2.3) and the method in [`bench/README.md`](../../bench/README.md):

- Linux arm64, Chrome for Testing 153.0.8010.36, a fresh headless instance for every run.
- Claude Sonnet 5.5 in Claude Code 2.1.301, each tool with its own shipped skill.
- [browser-cli 0.2.3](https://www.npmjs.com/package/@phnx-labs/browser-cli/v/0.2.3) built from b5779f7, [Browser Use 0.13.14](https://pypi.org/project/browser-use/0.13.14/), [browser-harness 0.1.13](https://pypi.org/project/browser-harness/0.1.13/), [agent-browser 0.41.2](https://www.npmjs.com/package/agent-browser/v/0.41.2). Browserbase `browse` was not in this run.
- Two runs per task (64 suite runs) and two several-agents trials per tool (8 trials). Model spend reported by Claude Code: $5.94.

Every run's record is in [`bench/results/2026-11-07/`](../../bench/results/2026-11-07/), with `summary.md` as `bun bench/run.ts summary` printed it. Local paths are replaced with `~` and `<run>`, and the `skills`, `plugins` and `tools` lists are left out because they list the runner's own Claude Code install; in every run the first skill listed was the tool's own. Transcripts are not included.

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
| books | 5.0 turns, 14 s | 4.0 turns, 12 s | 4.5 turns, 13 s | 8.5 turns, 22 s |
| pizza | 5.0 turns, 14 s | 5.0 turns, 15 s | 5.0 turns, 13 s | 12.5 turns, 27 s |
| bun | 4.0 turns, 11 s | 8.0 turns, 28 s | 6.5 turns, 22 s | 14.5 turns, 37 s |
| saucedemo | 6.0 turns, 20 s | 6.5 turns, 25 s | 7.0 turns, 24 s | 25.5 turns, 71 s |
| laptops | 5.5 turns, 18 s | 5.0 turns, 20 s | 5.5 turns, 21 s | 22.5 turns, 46 s |
| demoblaze | 9.0 turns, 30 s | 6.5 turns, 34 s | 7.5 turns, 40 s | 16.5 turns, 44 s |
| instagram | 4.5 turns, 10 s | 4.0 turns, 16 s | 4.5 turns, 12 s | 8.0 turns, 18 s |
| wikipedia | 8.0 turns, 20 s | 5.5 turns, 14 s | 5.0 turns, 13 s | 10.0 turns, 22 s |

### Several agents, one browser

Three Claude Code agents at once in one browser (books, pizza, saucedemo), each told "Work only in tabs you opened yourself", two trials per tool. A run saw another agent's tab when another agent's host or page title appeared in its tool output; each record's `leakingCommands` lists the commands and what they showed.

| Tool | Tasks solved | Runs that saw another agent's tab | Wall seconds per trial |
|---|---:|---:|---:|
| **browser-cli 0.2.3** | 6/6 | **0/6** | 86, 80 |
| browser-harness 0.1.13 | 6/6 | 6/6 | 28, 26 |
| Browser Use 0.13.14 | 6/6 | 4/6 | 30, 38 |
| agent-browser 0.41.2 | 6/6 | 6/6 | 64, 44 |

browser-harness and Browser Use showed other agents' tabs through `list_tabs()`, agent-browser through `tab` and `snapshot`, with each agent on its own `--session`. browser-cli was the slowest of the four here: its saucedemo agent took 80 and 86 s at 6 turns, against 20 s alone, and its pizza agent 54 and 55 s against 14 s. The records hold per-agent seconds and turns, not where the time went.

## How it compares

The comparison of browser-cli with other tools comes from reading each tool's own docs and source, not from runs: [How it compares](../comparison.md), with a source link in every cell, pinned to the commit read on 2026-11-07 (Claude in Chrome's docs are live pages, quoted as of that day).


Earlier runs, from 2026-10-19, used a script that is not in this repository: [archive](archive-2026-10-19.md).
