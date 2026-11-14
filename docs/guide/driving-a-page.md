# Driving a page

The loop an agent runs: list what it can act on, act, read the result.

```sh
browser start --url https://example.com --snapshot   # task name, then the page's refs
browser refs                               # numbered interactive elements
browser text                               # title, URL and the readable text
browser text --grep "Total|Tax"            # only the matching lines
browser text --css ".product"              # each match's text, one block per match
browser click 3 --snapshot                 # act, then print the page it left
browser click --text "Checkout"            # by accessible name, optionally --role button
browser type 5 "ada@example.com"           # text positionally, or --text
browser type "Email" "ada@example.com"     # or name the field by its label
browser type 9 "19:45"                     # date and time inputs take their value
browser select 7 "Large"                   # a <select> option by label or value
browser press Enter --snapshot
browser dialog accept                      # or dismiss: answers a confirm() or prompt()
browser navigate https://shop.example/p/1 && browser click --text "Add to cart" && browser text
```

- **Refs** are numbers from the latest listing. A ref keeps naming its element while that element is on the page, even when a number in its label changes; one that drifted is matched again by role and name before the action, within the same frame.
- **`--snapshot`** on `start`, `navigate`, `click`, `type`, `select` and `press` prints the new URL, title and refs in the same call, numbered as `browser refs` would number them, and saves a compressed screenshot as `browser screenshot` would, printing its path (`screenshot: …`). Native Arc skips the screenshot, since capturing there selects the tab in its window; run `browser screenshot` when you need one. With `--device` the path is on that device.
- **Settling.** In Chromium-family browsers each action returns once the page has settled: a navigation it started is waited for, up to 3 seconds, and a navigation also waits up to 1.5 s for the requests that draw the page after its load. So known steps chain with `&&`, each seeing the page the last one led to. `--no-wait` returns as the action lands. On Firefox and Arc commands return as the action lands. There, follow a step that changes the page with `browser wait --selector <css>`, `--url <pattern>` or `--state load` before reading it. In Arc, `evaluate` and `--fn` see the page's DOM but not its JavaScript variables.
- **Dialogs.** An `alert()` or leave-page prompt is accepted and printed. A `confirm()` or `prompt()` waits: the action that raised it prints the question, and `browser dialog accept|dismiss` answers it.
- **iframes.** In Chromium-family browsers, `refs` lists elements inside same-site and cross-site iframes under an `- iframe "<url>"` line, and `click`, `type`, `hover` and `select` act on them; `text` reads them too. One level of frames below the page is covered. To upload into a cross-site iframe, `navigate` to the frame's URL, which `upload` prints, and upload there.
- **Off-screen elements** are scrolled into view before a click or hover.
- **Pages without usable refs** (canvas apps, custom widgets): take a `screenshot` and click by position with `click --at X,Y`.
- **Files.** `browser upload -r <ref> -f /path/to/file` fills a file input or drop zone; `--trigger <ref>` answers the file chooser a button opens. `browser download --path <dir>` sets where the task's downloads land (the profile's downloads folder by default), and `browser waitdownload` waits for one to finish.
- **Testing a page.** `browser console`, `browser errors`, `browser requests` (`--format har` for a HAR file) and `browser responsebody <url-pattern>` read what the page logged, threw and fetched. `browser set device "iPhone 14"` and `browser set viewport <w> <h>` emulate a screen.
- **Many steps in one process.** `browser stream` reads NDJSON requests on stdin and keeps one connection to the service open.

`BROWSER_TRACE=1` in the service's environment logs the time spent in every request and every CDP call to the service log.
