---
description: Drive perplexity.ai for deep research (Computer mode) or fast Pro Search. Captures the URL/mode distinction, sign-in quirks, prompt structure, fan-out pattern, and export methods verified on the current site.
---

# Perplexity

Perplexity has **two run modes** with very different output. Picking the wrong one is the #1 mistake.

| Mode | URL | Output | When to use |
|---|---|---|---|
| **Pro Search** | `/search/<slug>` | Single-turn answer, no artifacts | Quick lookups |
| **Computer** | `/computer/tasks/<slug>` | Multi-step agentic run, PDF + charts + CSVs as files | Deep research, comparisons, briefings |

To force Computer mode, **submit from `/computer/tasks`, not from `/`**. Submitting from `/` silently falls back to Pro Search even if the prompt asks for a "deep research report".

## URLs

| URL | What |
|---|---|
| `https://www.perplexity.ai/` | Home. Composer defaults to Pro Search. **Do not submit from here.** |
| `https://www.perplexity.ai/computer/tasks` | Computer home. Composer always in Computer mode. **Start here.** |
| `https://www.perplexity.ai/computer/tasks/<slug>` | Individual Computer task — progress, report, Usage, Share. |

## Prerequisites

- Account on **Perplexity Max** (Computer mode is Max-only).
- Credits in the top-right toolbar. Budget: ~50–200 credits per one-shot Computer run, ~500–1500 for a fan-out (see below).

## Submitting a Computer run

1. **Open** `https://www.perplexity.ai/computer/tasks` in a new tab. Snapshot to get refs.
2. **Check for sign-in.** If the snapshot shows `textbox "Enter your email"` or `button "Continue with Google"`, the session expired. Re-auth via email-code flow. **Type each OTP digit into its own field (e3..e8) — the 6-digit input clips each field to 1 char.**
3. **Dismiss banners.** The "5,000 bonus credits" and "Enable notifications" overlays don't block submission but obscure screenshots. Dismiss with:
   ```js
   () => { const el = Array.from(document.querySelectorAll("button,a"))
     .find(n => (n.textContent||"").trim().toLowerCase() === "dismiss all");
     if (el) el.click(); }
   ```
4. **Click the composer textbox**, **type the query**, **click submit**, sleep 4s.
5. **Verify mode** — `evaluate () => location.href` must return `/computer/tasks/<slug>`. If it returns `/search/<slug>`, you submitted from the wrong page. Retry from `/computer/tasks`.

Save the resulting task URL — it's the persistent, shareable link.

## Prompt structure (the difference between a 1500-word report and a 4500-word one)

Computer rewards specificity. A good brief names:

- **Scope** — topic + explicit comparison set
- **Artifacts** — "comparison table", "chart of X", "under 1500 words"
- **Sources** — "cite all", "prefer primary", "exclude marketing pages"
- **Format** — "one-page briefing" / "technical memo" / "investor FAQ"

Example:
> Produce a concise research briefing on AI browser agents. Compare Anthropic Computer Use, Perplexity Computer, ChatGPT Agent, Perplexity Comet. Include a side-by-side capability table (release dates, pricing, supported actions, context length, limitations). Add at least one chart. Under 1500 words. Cite all sources.

## Fan-out pattern (for high-depth research)

Explicitly tell Computer to spawn parallel sub-agents:

> Spin up N parallel sub-agents, each specialized on one aspect, and consolidate their findings into an expanded report.
> (1) `<role>` agent: `<questions / sources>`.
> (2) `<role>` agent: `<questions>`.
> Each sub-agent should produce at least `<N>` words and cite primary sources. Final consolidated report `<target length>`.

Verified behavior:
- Computer writes a detailed brief per sub-agent, routes each to a different underlying model.
- Sub-agents write to `/home/user/workspace/agentN_<slug>.md` (visible in the live stream).
- Orchestrator reads all outputs and produces the consolidated report.
- **Sweet spot: 3–6 sub-agents.** Below 3 is overkill; above 6 dilutes focus.
- **Cost (2026-04):** 5-agent fan-out producing 4,658 words + 2 charts ≈ 1,260 credits (vs. 122 for a 1,340-word one-shot).
- **Runtime (2026-04):** 5-agent fan-out ≈ 13 min end-to-end (vs. 4 min one-shot).

## Polling for completion

Computer runs take 4–25 minutes. Background long waits; never block on a single sleep.

| Signal | Meaning |
|---|---|
| "Researching X", step cards scrolling, active URL citations | Still running |
| Main area renders headings + paragraphs of final report | Done |
| Top-right toolbar shows `Share` + `⋯` menu | Done |
| Composer placeholder changes from `Type a command...` | Done |
| Sidebar task title loses ellipsis | Done |

If a run exceeds 25 min with no new step cards across two polls 5 min apart, it stalled. Screenshot and ask the user whether to cancel.

## Exporting — three parallel deliverables

A Computer run produces **attachments** (PDFs, PNG charts, sometimes CSV/XLSX), not just a rendered page. Capture all three.

### A. Page-as-PDF (always works)

Run `browser pdf --task <task>` (CDP browsers). It captures the whole run narrative and inline artifacts.

### B. Figure images

```js
() => Array.from(document.querySelectorAll("img"))
  .map(i => i.src)
  .filter(s => s && s.includes("pplx-res") && (s.includes(".png") || s.includes(".jpg")))
```

Returns Cloudinary URLs — curl them directly.

### C. Full markdown body

The report ships as an `.md` attachment. Click the document button to open the dialog, then extract:

```js
// click the .md attachment button (no quotes inside braces, so Claude Code runs it without asking)
() => ((b) => b ? (b.click(), "clicked") : "not-found")(Array.from(document.querySelectorAll("button"))
  .find((n) => /\.md$|Document/.test(String(n.textContent).trim()) && n.querySelector("img,svg")))
// after click, extract full text from the dialog
() => (document.querySelector("[role=dialog] article") || document.querySelector("article"))?.innerText ?? ""
```

The Document viewer has a `Download` button but it doesn't reliably trigger a file download under browser automation. DOM extraction is the reliable path.

## Gotchas

- **Submit from `/computer/tasks`, not `/`** — most common mistake. From `/`, the run goes to Pro Search and there is no PDF.
- **Follow-up composer is buggy for scripted input.** On a task page (`/computer/tasks/<slug>`), the "Type a command..." textbox reports `ref matched 2 elements`, and paste events into the contenteditable duplicate content. To ask a follow-up, open a **new task** referencing the prior one ("building on the previous task X, now go deeper into Y").
- **OTP digits are per-field** — type each digit to its own ref (`e3`–`e8`), not all six into `e3`.
- **Refs change after every action** — always re-snapshot before clicking.
- **Credits are real** — Computer runs are metered. Check the counter before starting a long run. Don't double-submit; Perplexity doesn't dedupe.
- **Notifications overlay** can obscure UI in screenshots. Dismiss via JS before polling.

## Decision defaults

- **Model**: leave default. Computer picks.
- **Citations**: already on.
- **Output format**: PDF + figures + extracted `.md`. Markdown body is the primary text artifact.
- **Depth**: Computer IS the deep mode. Don't layer "Deep Research" flags. Write a precise brief instead.
