---
description: Image generation via higgsfield.ai (Nano Banana 2). The prompt input is a Lexical editor — standard typing fails.
---

# Higgsfield

Drive higgsfield.ai for image generation. This skill captures the **exact** selectors, controls, and input recipe verified working on the current site (2026-05).

## URL

Use the query-param URL — the path-style URL redirects to the marketing page when logged out:

```
https://higgsfield.ai/ai/image?model=nano-banana-2
```

## Preferred defaults

| Control | Value |
|---|---|
| Model | **Nano Banana 2** (the fast Pro-quality one — not "Pro", not "Flash") |
| Resolution | **2K** |
| Batch size | **4/4** |
| Aspect | per task (16:9 default) |

Generate cost at these defaults: **10.8 credits** per click (2.7 × 4).

## The prompt input is a Lexical editor

The prompt textbox has `data-lexical-editor="true"`. This means:

- `browser type` **fails silently** (Lexical owns the state, DOM writes don't stick).
- `document.execCommand("insertText", ...)` **returns false** (Lexical preventDefaults the legacy path).
- Setting `.textContent` / `.value` / native input value setter **fails** (Lexical re-renders from its internal model and overwrites).

The recipe that **does** work is to dispatch the same event Lexical's listener handles — a real `InputEvent("beforeinput")` with `inputType: "insertText"`:

```js
const el = document.getElementById('hf:tour-image-prompt');
el.focus();

// Place caret at end
const sel = window.getSelection();
const range = document.createRange();
range.selectNodeContents(el);
range.collapse(false);
sel.removeAllRanges();
sel.addRange(range);

// Dispatch the event Lexical listens for
el.dispatchEvent(new InputEvent('beforeinput', {
  inputType: 'insertText',
  data: 'your prompt text',
  bubbles: true, cancelable: true, composed: true,
}));
```

To clear before inserting, do the same with `inputType: 'deleteContentBackward'` over a selectAll range, then insert.

After dispatch, `el.textContent` will hold the text and `el.innerHTML` will be `<p class="text-sm" dir="auto"><span data-lexical-text="true">your text</span></p>`.

## Control map (verified live)

| Control | Selector | Notes |
|---|---|---|
| Prompt editor | `#hf:tour-image-prompt` | Lexical contenteditable — use beforeinput recipe above |
| Model button | `button` whose text matches `/Nano Banana 2/` | Opens a modal sheet (NOT a listbox) |
| Aspect button | `button` with text equal to current aspect (e.g. `'16:9'`), `aria-haspopup="listbox"` | Click → react-aria listbox with `[role="option"]` |
| Resolution button | `button` with text equal to `'2K'` etc., `aria-haspopup="listbox"` | Click → listbox with options `1K`, `2K`, `4K` |
| Decrement | `button[aria-label="Decrement"]` | Disabled when count=1 |
| Increment | `button[aria-label="Increment"]` | Disabled when count=4 |
| Generate | `button` whose text starts with `/^Generate/` | Disabled if prompt empty |

### Aspect listbox options (current)

`Auto, 1:1, 3:4, 4:3, 2:3, 3:2, 9:16, 16:9, 5:4, 4:5, 21:9`

Option elements use `[role="option"]` with `id` patterns like `react-aria…-option-16:9`. Match by `textContent.trim()`.

### Resolution listbox options

`1K, 2K, 4K`. Selected one has `aria-selected="true"`.

### Model sheet rows

The model button opens a sheet (not a listbox). Each row's leading text is the model name; trailing text is a tagline. Match by `textContent` starting with the model name:

```
GPT Image 2 New | 4K images with near-perfect text rendering
Seedream 5.0 lite | Unlimited | Intelligent visual reasoning
Seedream 4.5 | Unlimited | ByteDance's next-gen 4K image model
Nano Banana 2 | Pro quality at Flash speed         ← default
Nano Banana Pro | Unlimited | Google's flagship
Nano Banana | Unlimited | Google's standard
…and more below the fold
```

## Quirks (verified, not folklore)

- **Refs change after every action** — after clicking a dropdown to open it, the options aren't in the prior `browser refs` snapshot. Re-snap or use JS to find `[role="option"]`.
- **Count drifts back to 4/4** between sessions or page state shifts. Don't assume it stayed at 1 if you set it last time; re-check before clicking Generate.
- **The path-style URL `/image/nano_banana_2` redirects to a marketing/login page.** Only the query-param URL above lands on the working generator.
- **Promo / tour dialogs** sometimes overlay the editor. Press `Escape` to dismiss.
- **The prompt field's id `hf:tour-image-prompt`** contains a colon, which is a valid HTML id but tricky in CSS selectors — use `getElementById`, not `querySelector('#hf:tour-image-prompt')`.

## Downloading generated images

New images appear as `<img>` tags whose `src` matches `/(higgsfield|storage|cdn|amazonaws|cloudfront)/i`. Snapshot the URL set before clicking Generate, poll for the difference after, and `curl -sLfo` the first new URL. They're public CDN URLs — no cookies needed.

## When something breaks

1. Did the URL redirect? You probably hit the path-style URL or aren't logged in. Re-navigate with the query-param URL.
2. Did the prompt visually appear but Generate stays disabled? You set `.textContent` instead of dispatching `beforeinput` — Lexical's state is still empty even though the DOM looks populated.
3. Did Generate click but no image arrive after 60s+? Check `browser console` for rate-limit or auth errors. Higgsfield throws 402 when out of credits.
