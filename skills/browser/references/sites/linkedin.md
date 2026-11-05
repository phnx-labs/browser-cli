---
description: Drive LinkedIn (linkedin.com) over CDP — find people, open profiles, read contact info, and send InMail/messages. Captures the hard-won gotchas (ref renumbering under daemon mismatch, the iframe message composer, navigate-by-URL, href extraction) verified on the current LinkedIn web app.
---

# LinkedIn

LinkedIn is a React SPA with heavy server-driven rendering and an **iframe-based message composer**. The two biggest time sinks are (1) ref numbers drifting/renumbering between snapshots, and (2) trying to type into the InMail body, which lives in an iframe that CDP `type` cannot focus. Use the patterns below.

## The gotchas (each one cost real time)

1. **Refs renumber on every `refs` call and go stale fast.** Element refs change between snapshots and a ref can become "not focusable" / "Ref N not found" the moment the DOM re-renders (which typing or clicking triggers). Two consequences:
   - Capture a ref and use it in the **very next** command. Do not screenshot or re-`refs` in between.
   - A stale-ref `click` can land on a background link and **navigate the page** out from under you. After any click that "didn't seem to work," screenshot before retrying.

2. **Stale browser service → ref drift.** If `browser` reports the browser service is running on an older version than the CLI, refs mismap and clicks misfire. Run `browser stop --service`, then retry; the next command starts a current service. Prefer the **navigate-by-URL** and **evaluate** patterns below, which don't depend on refs.

3. **Navigate by URL — don't click search results.** Extract profile URLs from the DOM and `browser navigate --url` straight to them. Far more reliable than clicking a result (whose ref drifts between snapshot and click).
   ```bash
   # Get profile hrefs off a people-search results page:
   browser evaluate -e "Array.from(document.querySelectorAll('a[href*=\"/in/\"]')).map(a=>a.href.split('?')[0]).filter((v,i,s)=>s.indexOf(v)===i).slice(0,8).join('|')"
   # First /in/ link on a people-search page is the top result. Then:
   browser navigate --url "https://www.linkedin.com/in/<vanity>/"
   ```
   People search URL: `https://www.linkedin.com/search/results/people/?keywords=<url-encoded query>`

4. **Click by visible text via `evaluate`, not by ref.** When you must click (e.g. "Contact info", "Message"), find the element by text in `evaluate` and `.click()` it — immune to ref drift:
   ```bash
   browser evaluate -e "const a=[...document.querySelectorAll('a,button')].find(x=>/contact info/i.test(x.textContent)); a?(a.click(),'clicked'):'not found'"
   ```

5. **Contact info rarely has an email.** For senior people, the "Contact info" modal shows only the LinkedIn URL — no email, site, or phone. Don't fabricate a corporate email. Reach them via InMail or a warm intro instead.

6. **Navigate by URL.** `browser navigate "https://..." --task li` (or `--url`).

7. **`press` has no modifier/letter support.** Only named keys (Enter, Tab, Escape, arrows, Space, etc.). You **cannot** send Cmd+V / Cmd+K from `press`. So you cannot paste into a field via `press`.

## The InMail / message composer (the hard part)

Clicking **Message** on a profile opens a "New message" overlay. For a 3rd-degree connection it is an **InMail** and shows `Use 1 of N InMail credits` (requires LinkedIn Premium). The overlay renders **inside an iframe**:

- `document.querySelectorAll('[contenteditable]')` from the top frame returns **0** — the body is in one of ~3 iframes. Top-frame `evaluate` (incl. the slack-style `execCommand('insertText')`) **cannot reach it**.
- CDP `type` by ref **does** cross frames: the **Subject input is typeable** (`browser type <ref> --text "..."` works, `--clear` to replace).
- The **body is a `contenteditable` div** and CDP `type` reports **"Element is not focusable"** every time (DOM.focus fails on contenteditable-in-iframe). A `click` on the body ref focuses it but immediately invalidates the ref, and there's no "insert into focused element" command.

**Net:** as of this writing, there is no verified one-shot CLI path to fill the InMail **body**. Options, best first:

1. **Hand the user the text + clipboard.** `printf '%s' "<body>" | pbcopy`, leave the composer open, user clicks the body and hits Cmd+V. One keystroke, no copy step.
2. **Try the full messaging thread URL instead of the overlay** (UNVERIFIED lead worth testing): open `https://www.linkedin.com/messaging/thread/new/?recipient=<urn>` or the messaging page directly — the composer there may render in the **main frame**, making the slack-style `el.focus(); document.execCommand('insertText', false, text)` work via `evaluate`. Test before relying on it.
3. **Subject is fillable now** via `type`; only the body is blocked.

**Never auto-send.** Sending an InMail spends a credit and is outbound to a real person. Fill (or hand over) the draft, screenshot to confirm, and let the human press Send. The harness will (correctly) block composing outbound messages unless the user has explicitly authorized that specific send.

## Canonical flow (find a person → draft an InMail)

```bash
browser start --task li --url "https://www.linkedin.com/search/results/people/?keywords=Jane%20Doe%20Acme"
# bare start uses your configured default browser

# 1. Pull the top result's profile URL from the DOM, navigate straight to it
browser evaluate -e "document.querySelector('a[href*=\"/in/\"]').href.split('?')[0]"
browser navigate --url "https://www.linkedin.com/in/<vanity>/"
browser screenshot        # confirm identity, note mutual connections (warm-intro path)

# 2. Check contact info (usually just the LI URL)
browser evaluate -e "const a=[...document.querySelectorAll('a,button')].find(x=>/contact info/i.test(x.textContent)); a&&a.click()"

# 3. Open the message/InMail composer
browser evaluate -e "const b=[...document.querySelectorAll('button,a')].find(e=>/^\\s*Message\\s*$/i.test(e.textContent.trim())); b&&b.click()"

# 4. Subject is typeable; capture ref and type immediately (no refs/screenshot in between)
S=$(browser refs | grep -i "Subject (optional)" | grep -oE 'ref=[0-9]+' | head -1 | cut -d= -f2)
browser type "$S" --clear --text "<subject>"

# 5. Body (iframe contenteditable) — hand it off via clipboard, do NOT auto-send
printf '%s' "<body>" | pbcopy   # user clicks the message box and Cmd+V

# 6. Screenshot, then let the human review + Send.
browser screenshot
```

## Notes

- **Mutual connections beat cold InMail.** A profile shows "Followed by <names> you know" — a warm forward from one of them outperforms a cold InMail and costs no credit. Mention this option when handing off.
- **Premium InMail credits** are finite (e.g. 15). One InMail = one credit, charged on send. Composing/abandoning costs nothing.
- **Experience section confirms background** (e.g. "Head of Entrepreneurship at Stripe, 2017–2022") — useful for personalization; scroll the profile and screenshot.
