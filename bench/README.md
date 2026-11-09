# bench

Reruns the 2026-11-07 [benchmarks](../docs/benchmarks/README.md): eight graded web tasks and the several-agents test, for browser-cli and the three other tools in the README's chart.

It follows the method of the [2026-10-19 runs](../docs/benchmarks/archive-2026-10-19.md), with every task prompt written down in [`tasks.json`](tasks.json). Those runs used an earlier script, so compare numbers within one date, not across dates.

It needs Linux, Bun, uv (it installs Python 3.12 for the Python tools), Node with npm and npx, and a signed-in `claude`. It runs the four tools in the README's chart at the versions `bench/setup.sh` pins (`BROWSER_USE_VERSION`, `BROWSER_HARNESS_VERSION`, `AGENT_BROWSER_VERSION` and `CHROME_VERSION` override them).

```bash
bash bench/setup.sh                    # installs dependencies, builds browser-cli into dist/, installs the other tools and Chrome for Testing into bench/.work, runs `check`
bun bench/run.ts check                 # no model: each tool opens a page in a fresh headless Chrome and the grader reads it
bun bench/run.ts suite --runs 5        # 8 tasks x 5 runs per tool, interleaved
bun bench/run.ts isolation --runs 10   # three agents at once in one browser, 10 trials per tool
bun bench/run.ts summary               # tables from bench/results/<date>/
```

How a run works:

- Claude Code runs headless (`claude -p`, Claude Sonnet 5.5 unless `BENCH_MODEL` says otherwise) with the tool's own shipped skill as its only project skill, only the tool's command allowed in Bash plus the Skill tool, no file writes, web fetch or sub-agents, and no user settings files, plugins or MCP servers (`--setting-sources project --strict-mcp-config`). Each result records the skills, tools and permission denials Claude Code reported, so a run where the skill did not load shows it.
- Every run gets a fresh headless Chrome for Testing 153 with its own user-data-dir, each tool runs with an empty HOME (Claude Code keeps yours, for its sign-in), and every tool attaches to it over CDP: browser-cli through an `--attach-only` profile, Browser Use and browser-harness through `BU_CDP_URL`, agent-browser through `AGENT_BROWSER_CDP`. browser-cli runs from this checkout's `dist/` build, never an installed `browser`.
- Chrome starts with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling`. Without them, headless Chrome 153 on Linux never loads a tab opened behind another, and every tool stalls on it alike.
- Each answer is graded from the pages the agent left open and from its final message, against ground truth the grader reads from the live site at grading time ([`bench/grade.ts`](grade.ts)); Demoblaze's total is fixed at 1180, the price of the two phones. Two tasks are graded only by where they ended: the pizza order by the form fields httpbin echoes back, the Saucedemo checkout by its order-complete page being open, which does not show whether the products were sorted first.
- Turns, tokens (input including cached context, plus output) and cost are Claude Code's own `result` numbers; seconds are the wall time of the `claude` process. Each run writes one JSON under `bench/results/<date>/`; transcripts stay in the run directory (`/tmp/bcb` by default) because they hold local paths.
- A run that failed outside the tool (no `result`, an API or auth error, a grader that could not read the truth) goes to `errors/` instead: it counts toward the budget, not toward a table, and runs again next time.
- In the several-agents test, a run "saw another agent's tab" when another agent's host or page title (`marks` in `tasks.json`) appears in that agent's tool output.
- The harness runs on Linux: it cleans up each run's processes through `/proc` and starts Chrome with `--ozone-platform=headless`.
- A run does not start when the money already spent that day plus the mean cost of the runs left would pass `BENCH_BUDGET_USD` (default 60). Running a command again skips runs whose JSON already exists.
