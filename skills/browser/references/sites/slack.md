---
description: Drive Slack (app.slack.com) over CDP — open channels/DMs, read messages and threads, transcribe voice notes, search, and send messages. Captures the hard-won gotchas (virtualized sidebar, the texty_input trap, React inputs, safe-send) verified on the current Slack web app.
---

# Slack

Slack's web app is a virtualized React SPA. Two mistakes waste the most time: (1) clicking the sidebar to navigate, and (2) typing into the wrong `texty_input`. Avoid both with the patterns below.

## The 5 gotchas (each one cost real time)

1. **Navigate by URL — do NOT click the sidebar.** Channel/DM rows are virtualized `[role="treeitem"]`; clicking by ref returns `Ref has no DOM node`, and synthetic mouse events do **not** route through Slack's React handlers. Instead extract the team id + channel/DM id and `browser navigate` to `https://app.slack.com/client/<TEAM>/<ID>`. See `scripts/slack/find-ids.js`.
2. **The `texty_input` trap.** The global search box AND the message composer both have `data-qa="texty_input"`. Targeting the wrong one means you type your search into the channel composer (one keystroke from posting it). Disambiguate:
   - **Search** = `[role="combobox"][aria-label="Query"]` inside `[role="dialog"]` → `scripts/slack/type-search.js`
   - **Composer** = `[data-qa="texty_input"]` with `aria-label` starting `"Message "`, NOT inside a dialog → `scripts/slack/type-composer.js`
3. **React inputs need `execCommand`.** Setting `.value` / `.textContent` does nothing — Slack ignores it. Use `el.focus(); document.execCommand('insertText', false, text)`.
4. **Send safely: compose → screenshot → Enter.** Never insert-and-Enter blind. Compose with `type-composer.js`, `browser screenshot` to confirm the text and that you are in the right conversation, THEN `browser press Enter`.
5. **Stale browser service → ref drift.** If `browser` reports the browser service is running on an older version than the CLI, refs mismap and clicks misfire. Run `browser stop --service`, then retry; the next command starts a current service.

## Canonical flow

```bash
browser start --task slack --url https://app.slack.com/client
# bare start uses your configured default browser

# 1. Find the team + channel/DM ids
browser evaluate --task slack --file "$(browser skills path)/scripts/slack/find-ids.js"

# 2. Open a conversation BY URL (not by clicking)
browser navigate --task slack --url "https://app.slack.com/client/<TEAM>/<ID>"
browser screenshot --task slack

# 3. Read a thread: click its reply bar, then
browser evaluate --task slack --file "$(browser skills path)/scripts/slack/read-thread.js"

# 4. Voice note: run twice (1st click generates, 2nd reads after ~6s)
browser evaluate --task slack --file "$(browser skills path)/scripts/slack/read-transcript.js"

# 5. Send a message (edit ARG in the script first)
browser evaluate --task slack --file "$(browser skills path)/scripts/slack/type-composer.js"
browser screenshot --task slack          # VERIFY text + conversation
browser press --task slack Enter
```

## Scripts

| Script | Purpose |
|---|---|
| `scripts/slack/find-ids.js` | Returns team id + every sidebar channel/DM id with its label, plus a ready navigate URL. |
| `scripts/slack/type-search.js` | Types into the search combobox (edit `ARG`). Open search first (click the Search button). |
| `scripts/slack/type-composer.js` | Types into the current channel/DM composer (edit `ARG`). Does NOT send. |
| `scripts/slack/read-transcript.js` | Generates (1st call) then reads (2nd call) a voice-note transcript. |
| `scripts/slack/read-thread.js` | Reads replies from the open thread flexpane. |

## Notes

- **Voice notes** post as an audio clip; Slack auto-transcribes on demand. The inline preview is truncated — always expand via "View transcript" (handled by `read-transcript.js`).
- **`press`** only supports named keys (Enter, Tab, Escape, arrows). It has NO modifier/letter support — you cannot do Cmd+K from `press`; navigate by URL instead.
- **Search results** are clickable but their refs drift between snapshot and click; prefer navigating by id over clicking a result.
