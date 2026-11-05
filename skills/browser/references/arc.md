# Arc

An Arc profile is driven natively through Apple Events, not CDP. The task's tabs open in an Arc window of their own, the agent window, which `browser` opens behind the user's apps the first time a task needs it and reuses after that. Arc shares a Space's tabs between its windows, so your tabs also list in the user's sidebar, but the user's window keeps the tab they had and Arc is not brought forward.

## Screenshots

`browser screenshot` selects your tab in the agent window and captures that window without raising it. The image is the page only: Arc's sidebar, which lists the user's tabs, and the toolbar are cropped off. It needs the Computer helper (`computer setup`), which holds the macOS Screen Recording permission, and the agent window on screen with its sidebar showing, not minimized or on another desktop. `-q raw` is a PNG of a quality-100 JPEG capture. A capture is kept only when macOS titles the window with your tab's title, so a page whose title keeps changing (an unread count, say) can fail with `did not show the task's tab`. The service reads Arc's layout from the signed-in user's `~/Library/Application Support/Arc`, so a service started under a redirected `HOME` refuses every capture.

Do not minimize or close the agent window. A closed one, and possibly a minimized one, is replaced by a new window on the next `start`, and tasks in the old one cannot take screenshots.

A task started before the agent window existed has its tab in the user's own window, and its screenshot is refused. Start a new task.

## What Arc cannot do

These fail with `Native Arc does not support <capability>`:

- asynchronous JavaScript: `evaluate` runs synchronous expressions only
- `console` and `errors` capture, `requests` and `responsebody`
- `record`, `pdf`, `upload`, `download`, `set viewport`
- coordinate clicks (`click --at X,Y`)

Never switch to a different browser because Arc cannot do a step. Read the page as text instead, for example `browser evaluate "document.body.innerText.slice(0, 4000)" --task <task>`, and say the capture was not possible. Never pick another profile from `browser profiles list` to get around it.

Do not pass an async function to `evaluate`. Arc starts running it before the CLI rejects it, so side effects such as clicks still happen and a retry repeats them. Write the step as one synchronous expression.

## Sharing the user's Arc

- The user can click your tab in their own sidebar. Before any step that writes data (a note, a message, a form submit), check the page is still yours: `browser evaluate "location.href" --task <task>`. If the URL changed, stop and tell the user. Do not write into whatever page is showing.
- Do not run `browser tab focus`; `screenshot` selects the tab it captures.
- A screenshot is refused while another Arc window shows your tab: selecting it in the agent window would take it from that window.

## Errors

- `Creation marker did not resolve exactly one tab`: Arc created the tab late. Run your next command with the same `--task`; the task adopts the tab once it appears.
- `Arc Apple Event timed out`: Arc was busy. Retry once.
- `Owned Arc tab … is missing from its original window/Space`: the tab was closed or moved, or the agent window was closed. Start a new task; it opens a new agent window.
- `ScreenCaptureKit timed out` or `did not show the task's tab when it was captured`: three captures failed. Retry the screenshot once.
- `does not show its sidebar anchored`: the agent window's sidebar is hidden. Tell the user; a capture would not know where the page starts.
- `The agent's Arc window is not on screen`: it is minimized or on another desktop. Tell the user; do not raise it.
