# Benchmarks

How browser-cli compares with other browser tools for coding agents, measured as turns, wall time, tokens and cost per task. Each section says what was run, so the numbers can be reproduced.

## Reproduce

[`bench/`](../bench) runs the eight graded tasks and the several-agents test below. The 2026-10-19 sections were measured with an earlier script that is not in this repository; `bench/` follows the same method, with its task prompts written down in [`bench/tasks.json`](../bench/tasks.json), so its numbers compare with each other, not with those sections.

```bash
bash bench/setup.sh                    # builds browser-cli into dist/, installs the other tools and Chrome for Testing into bench/.work, runs `check`
bun bench/run.ts check                 # no model: each tool opens a page in a fresh headless Chrome and the grader reads it
bun bench/run.ts suite --runs 5        # 8 tasks x 5 runs per tool, interleaved
bun bench/run.ts isolation --runs 10   # three agents at once in one browser, 10 trials per tool
bun bench/run.ts summary               # tables from bench/results/<date>/
```

How a run works:

- Claude Code runs headless (`claude -p`, Claude Sonnet 5.5 unless `BENCH_MODEL` says otherwise) with the tool's own shipped skill as its only project skill, only the tool's command allowed in Bash plus the Skill tool, no file writes, web fetch or sub-agents, and no user settings, plugins or MCP servers (`--setting-sources project --strict-mcp-config`). Each result records the skills, tools and permission denials Claude Code reported, so a run where the skill did not load shows it.
- Every run gets a fresh headless Chrome for Testing 153 with its own user-data-dir and an empty HOME, and every tool attaches to it over CDP: browser-cli through an `--attach-only` profile, Browser Use and browser-harness through `BU_CDP_URL`, agent-browser through `AGENT_BROWSER_CDP`. browser-cli runs from this checkout's `dist/` build, never an installed `browser`.
- Chrome starts with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`. Without them, headless Chrome 153 on Linux never loads a tab opened behind another, and every tool stalls on it alike.
- Each answer is graded from the pages the agent left open and from its final message, against ground truth the grader reads from the live site at grading time ([`bench/grade.ts`](../bench/grade.ts)). Two tasks are graded only by where they ended: the pizza order by the form fields httpbin echoes back, the Saucedemo checkout by its order-complete page being open, which does not show whether the products were sorted first.
- Turns, tokens (input including cached context, plus output) and cost are Claude Code's own `result` numbers; seconds are the wall time of the `claude` process. Each run writes one JSON under `bench/results/<date>/`; transcripts stay in the run directory (`/tmp/bcb` by default) because they hold local paths.
- A run that failed outside the tool (no `result`, an API or auth error, a grader that could not read the truth) goes to `errors/` instead: it counts toward the budget, not toward a table, and runs again next time.
- In the several-agents test, a run "saw another agent's tab" when another agent's host or page title (`marks` in `tasks.json`) appears in that agent's tool output.
- The harness runs on Linux: it cleans up each run's processes through `/proc` and starts Chrome with `--ozone-platform=headless`.
- A run does not start when the money already spent that day plus the mean cost of the runs left would pass `BENCH_BUDGET_USD` (default 60). Running a command again skips runs whose JSON already exists.

## 2026-10-19: browser-cli, Browser Use and browser-harness

### Eight graded web tasks

Claude Sonnet 5.5 ran each task headless in Claude Code with one tool, that tool's own shipped skill, and only that tool's command allowed in Bash. Every run got a fresh headless Chrome for Testing 153; the three tools ran interleaved in the same window. Each answer was graded from the page the agent left open, not from its claim. Two runs per task, 16 per tool.

| Tool | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---:|---:|---:|---:|---:|
| **browser-cli 0.1.27** | 16/16 | **3.62** | **15.8** | **76k** | $0.0371 |
| Browser Use 0.13.11 | 16/16 | 4.00 | 17.5 | 90k | $0.0374 |
| browser-harness 0.1.13 | 16/16 | 3.94 | 18.0 | 88k | $0.0375 |
| browser-cli 0.1.23 (earlier run, before these changes) | 16/16 | 5.5 | 16.8 | 116k | |

Tasks: the cheapest five-star mystery book across catalogue pages (books.toscrape.com), a pizza order form with radios, checkboxes and a time input (httpbin.org), the latest Bun release's tag, asset count and file size (GitHub), a Saucedemo login and two-item checkout, the most expensive laptop across about 20 pages (webscraper.io), a two-phone Demoblaze order, a public Instagram profile's follower count, and the population of the 2022 World Cup winner's capital (Wikipedia).

Tokens count input, including cached context, plus output. Wall time is mostly the model thinking between turns, so it varies more between runs than turns and tokens do. With two runs per task, read single tasks as a direction.

### Browser Use Bench v2.1

[Browser Use Bench v2.1](https://github.com/browser-use/benchmark) is 200 long research tasks on live sites, scored 0-100 by weighted rubrics. Four tasks (`bu2-031`, `bu2-083`, `bu2-151`, `bu2-186`) were picked with a fixed seed. Each tool ran all four in eight passes (1-8) with the same setup as above, and each pass used the newest browser-cli at the time.

With 0.1.32 and 0.1.33, passes 5 to 8 (16 runs per tool). Quality is the benchmark's own rubric judge (`gpt-5.6-luna`, 0-100):

| Tool | Quality | Seconds/task | Turns/task | Cost/task |
|---|---:|---:|---:|---:|
| **browser-cli 0.1.32-0.1.33** | 45.4 | **90** | 17.3 | **$0.190** |
| Browser Use | 43.6 | 202 | **14.2** | $0.204 |
| browser-harness | **50.4** | 220 | 18.2 | $0.240 |

browser-cli scores slightly higher than Browser Use, is 2.2 times as fast and costs 7% less. browser-harness scores highest but takes 2.4 times as long and costs 26% more. Browser Use takes fewer, longer turns: it can run a whole task as one Python call, and once finished a task in a single turn that ran 742 seconds, so turns alone understate how long the agent works.

Passes 1-8 (32 runs per tool, including browser-cli 0.1.27 to 0.1.31; pass 9 is reported separately below):

| Tool | Quality | Seconds/task | Turns/task | Cost/task |
|---|---:|---:|---:|---:|
| **browser-cli** | 48.8 | **92** | 18.5 | **$0.198** |
| Browser Use | 44.8 | 196 | **15.6** | $0.212 |
| browser-harness | **49.8** | 186 | 17.6 | $0.230 |

All three tools drive the same model, so quality varies with the task far more than with the tool (per task, browser-cli / Browser Use / browser-harness on passes 5-8: 24 / 20 / 22, 54 / 68 / 80, 14 / 10 / 15, 90 / 77 / 84). With 16 to 32 runs per tool, read the quality gaps as close.

### With file writes allowed

The passes above let each tool run only its own command. Pass 9 also gave every tool Claude Code's Write tool, as in ordinary use, with browser-cli 0.1.33 and one run per task:

| Tool | Quality | Seconds/task | Turns/task | Cost/task |
|---|---:|---:|---:|---:|
| **browser-cli 0.1.33** | **57.8** | **164** | 22.8 | **$0.228** |
| Browser Use | 34.0 | 170 | **18.8** | $0.258 |
| browser-harness | 50.0 | 465 | 25.2 | $0.380 |

One run per task is noisy (per task: 20 / 33 / 35, 100 / 26 / 69, 16 / 0 / 16, 95 / 77 / 80); two long runs carry the means, browser-cli's 458 s on `bu2-083` for a perfect score and browser-harness's 1484 s on `bu2-031`. browser-cli is fastest and cheapest here, as in passes 5-8; on quality it ranks first, where passes 5-8 ranked it second to browser-harness. One run per task cannot separate them.

### Five tools on the eight tasks, browser-cli 0.1.33

The README's chart: the eight graded tasks above with agent-browser 0.39.1 and Browserbase `browse` 0.6.1 added, two runs per task, 16 per tool. These are separate runs (trials 11 and 12) from the three-tool table above, later the same day on live sites; Browser Use moved too (4.00 to 4.44 turns, 90k to 102k tokens), so compare tools within one table, not across the two.

| Tool | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---:|---:|---:|---:|---:|
| **browser-cli 0.1.33** | 16/16 | 4.50 | **14.4** | **97k** | **$0.041** |
| Browser Use 0.13.11 | 16/16 | **4.44** | 16.8 | 102k | $0.044 |
| browser-harness 0.1.13 | 15/16 | 4.69 | 15.8 | 105k | $0.046 |
| agent-browser 0.39.1 | 16/16 | 8.75 | 17.5 | 244k | $0.069 |
| Browserbase browse 0.6.1 | 15/16 | 9.88 | 85.4 | 273k | $0.104 |

Browserbase `browse`'s 85.4 s mean is mostly one Demoblaze run that took 810 s and 28 turns without an answer.

One browser-cli Instagram run started while the benchmark's Chrome was down and could not connect; it was set aside and run again (correct, 3 turns). A search of every run's transcript found no other run that hit the outage.

### Several agents, one browser

Three Claude Code agents ran at the same time in one browser: one browsed a shop across pages, one filled a pizza-order form, one completed a checkout. Every agent was told: "Work only in tabs you opened yourself." Each tool ran this twice, six agent runs per tool, on 2026-10-19. A script counted a run as showing another agent's tab when another agent's site appeared in that agent's tool output.

| Tool | Tasks solved | Runs whose output showed another agent's tab |
|---|---:|---:|
| browser-cli 0.1.24 | 6 / 6 | 0 / 6 |
| browser-harness 0.1.13 | 6 / 6 | 4 / 6 |
| Browser Use 0.13.11 | 6 / 6 | 4 / 6 |
| agent-browser 0.39.1 | 6 / 6 | 4 / 6 |
| Browserbase browse 0.6.1 | 5 / 6 | 5 / 6 |

browser-cli 0.1.23 leaked once (1 / 6): agents that ran `start` at the same moment raced to open the browser connection. 0.1.24 fixed the race, and its row comes from two fresh runs on the installed 0.1.24. The per-run transcripts are not in this repository.

### How it compares

The README's comparison table comes from reading each tool's source at a pinned commit and its documentation on 2026-10-19, not from runs. The pinned commits are not recorded in this repository, so check a row against the tool's current docs before relying on it.

### What the runs changed

Each browser-cli change since 0.1.23 came from reading the transcripts where it took more turns:

- **0.1.27:** actions return once the page has settled; no `--task` to pass; a repeated `start` keeps the session's task; `type` and `select` take a field's label; `click --text` waits for late elements; `text` prints plain spaces.
- **0.1.28:** `evaluate --file -` reads a script from stdin.
- **0.1.29:** `text --grep <pattern>`.
- **0.1.30:** the skill shows `evaluate` scripts that Claude Code runs without asking.
- **0.1.31:** `evaluate` runs scripts as the DevTools console does (a `const` can be declared again, top-level `await`).
- **0.1.32:** `text --css <selector>` lists each match, `--attr` reads an attribute, so list extraction needs no script.
- **0.1.33:** a `text --grep` miss no longer ends an `&&` chain, and the skill reads with `text --css` and `--grep` before writing a script.

In these benchmarks each tool may run only its own command. Several of the changes remove turns that Claude Code spent asking about a `$T` variable, a pipe into `grep`, a file write or a script it refused; with broader permissions the differences on turns are likely smaller.
