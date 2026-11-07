import type { CDPClient } from './cdp.js';
import type { RefNode, resolveRefToCoords } from './refs.js';

export async function clickAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
}

const COVER_FN = `function (target) {
  const frames = [];
  for (let w = target.ownerDocument.defaultView; w && w.frameElement; w = w.frameElement.ownerDocument.defaultView) frames.push(w.frameElement);
  for (let n = this; n; n = n.assignedSlot || n.parentNode || n.host) {
    if (n === target || frames.includes(n) || (n.tagName === 'LABEL' && n.control === target)) return null;
  }
  const e = this.nodeType === 1 ? this : this.parentElement;
  if (!e) return 'another document';
  const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  const text = (e.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  return e.tagName.toLowerCase() + (e.id ? '#' + e.id : cls) + (text ? ' "' + text + '"' : '');
}`;

export async function coverAt(cdp: CDPClient, sessionId: string, backendNodeId: number, x: number, y: number): Promise<string | undefined> {
  const { cssLayoutViewport: scrolled } = await cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics', {}, sessionId);
  const hit = await cdp
    .send<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(x + scrolled.pageX), y: Math.round(y + scrolled.pageY) }, sessionId)
    .catch(() => undefined);
  if (!hit) return 'nothing';
  if (hit.backendNodeId === backendNodeId) return undefined;
  const [over, target] = await Promise.all([hit.backendNodeId, backendNodeId].map((id) =>
    cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: id }, sessionId).then((r) => r.object.objectId)));
  try {
    const { result } = await cdp.send<{ result: { value?: string | null } }>('Runtime.callFunctionOn', {
      objectId: over, functionDeclaration: COVER_FN, arguments: [{ objectId: target }], returnByValue: true,
    }, sessionId);
    return result.value ?? undefined;
  } catch {
    return undefined;
  } finally {
    for (const objectId of [over, target]) if (objectId) await cdp.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}

const DISABLED = `this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true'`;

const PROBE_FN = `function () {
  if (${DISABLED}) return null;
  const target = this, seen = { hit: false }, root = target.getRootNode(), types = ['pointerdown', 'mousedown', 'click'];
  const on = (e) => { if (e.composedPath().includes(target)) seen.hit = true; };
  for (const type of types) root.addEventListener(type, on, true);
  seen.done = () => {
    for (const type of types) root.removeEventListener(type, on, true);
    return seen.hit || !target.isConnected;
  };
  return seen;
}`;

export async function armClickProbe(cdp: CDPClient, sessionId: string, backendNodeId: number): Promise<(() => Promise<boolean>) | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  try {
    const { result } = await cdp.send<{ result: { objectId?: string } }>('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: PROBE_FN,
    }, sessionId);
    if (!result.objectId) return undefined;
    return async () => {
      try {
        const seen = await cdp.send<{ result: { value?: boolean } }>('Runtime.callFunctionOn', {
          objectId: result.objectId, functionDeclaration: 'function () { return this.done(); }', returnByValue: true,
        }, sessionId);
        return seen.result.value !== false;
      } catch {
        return true;
      } finally {
        await cdp.send('Runtime.releaseObject', { objectId: result.objectId }, sessionId).catch(() => {});
      }
    };
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sessionId).catch(() => {});
  }
}

export async function clickInDom(cdp: CDPClient, sessionId: string, backendNodeId: number): Promise<boolean> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  try {
    const { result } = await cdp.send<{ result: { value?: boolean } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        if (${DISABLED}) return false;
        if (typeof this.click === 'function') this.click();
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
        return true;
      }`,
      returnByValue: true,
    }, sessionId);
    return result.value !== false;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sessionId).catch(() => {});
  }
}

export async function hoverAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y },
    sessionId
  );
}

export async function scrollAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x, y, deltaX, deltaY },
    sessionId
  );
}

// `Input.insertText` dispatches the real `beforeinput`/`input`/`textInput` sequence that
// framework-controlled inputs (React, Vue, contenteditable editors) listen for; per-character
// `dispatchKeyEvent` fires only keydown/keyup, which they ignore.
export async function typeText(
  cdp: CDPClient,
  sessionId: string,
  text: string
): Promise<void> {
  await cdp.send('Input.insertText', { text }, sessionId);
}

// `text` is what makes Chromium treat the key as typed: without '\r' on Enter
// no keypress fires and a form's implicit submission never happens, so
// "type the query, press Enter" silently did nothing on every search box.
const KEY_CODES: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

export async function pressKey(
  cdp: CDPClient,
  sessionId: string,
  keyName: string
): Promise<void> {
  const keyInfo = KEY_CODES[keyName];
  if (!keyInfo) {
    throw new Error(`Unknown key: ${keyName}. Valid: ${Object.keys(KEY_CODES).join(', ')}`);
  }

  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
      ...(keyInfo.text ? { text: keyInfo.text, unmodifiedText: keyInfo.text } : {}),
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    },
    sessionId
  );
}

const FOCUS_DESCENDANT_FN = `(function() {
  const selector = 'input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const candidates = this.querySelectorAll(selector);
  for (const el of candidates) {
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
})`;

// `DOM.focus` only works on natively focusable elements, but styled wrappers (Slack composer,
// MUI TextField, ...) often expose the wrapper as the ref and throw "Element is not focusable".
// Then focus the first focusable descendant.
export async function focusNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<void> {
  try {
    await cdp.send('DOM.focus', { backendNodeId }, sessionId);
    return;
  } catch (err) {
    const focused = await focusFirstFocusableDescendant(cdp, sessionId, backendNodeId);
    if (!focused) throw err;
  }
}

async function focusFirstFocusableDescendant(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<boolean> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return false;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { value: boolean } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: FOCUS_DESCENDANT_FN, returnByValue: true },
      sessionId
    );
    return result.value === true;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

/**
 * Sets a date or time input, which ignores `Input.insertText`, as a user's pick would; one field's text
 * ("07", "PM") goes as keystrokes. Returns what it reads, undefined if not such an input; throws if refused.
 */
export async function typeIntoValueInput(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number,
  text: string,
): Promise<{ reads: string } | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  if (!object.objectId) return undefined;
  try {
    const { result } = await cdp.send<{ result: { value?: { type: string; segment: boolean; ok: boolean; reads: string; wanted: string } | null } }>(
      'Runtime.callFunctionOn',
      { objectId: object.objectId, functionDeclaration: SET_VALUE_INPUT_FN, arguments: [{ value: text }], returnByValue: true },
      sessionId,
    );
    const outcome = result.value;
    if (!outcome) return undefined;
    if (outcome.ok) return { reads: outcome.reads };
    if (!outcome.segment) {
      throw new Error(`The ${outcome.type} input did not accept "${text}". It takes ${VALUE_FORMATS[outcome.type] ?? 'its own format'}.`);
    }
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sessionId).catch(() => {});
  }
  // One field of a split input: type it as keys, then read the whole input back.
  await cdp.send('DOM.focus', { backendNodeId }, sessionId).catch(() => {});
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
  }
  const { object: again } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  const { result } = await cdp.send<{ result: { value?: string } }>(
    'Runtime.callFunctionOn',
    { objectId: again.objectId, functionDeclaration: 'function() { const h = this.getRootNode().host; return (h || this).value ?? ""; }', returnByValue: true },
    sessionId,
  );
  return { reads: result.value ?? '' };
}

const VALUE_FORMATS: Record<string, string> = {
  time: 'HH:MM, 24-hour (19:45) or with AM/PM (7:45 PM)',
  date: 'YYYY-MM-DD (2026-10-18)',
  'datetime-local': 'YYYY-MM-DDTHH:MM (2026-10-18T19:45)',
  month: 'YYYY-MM (2026-10)',
  week: 'YYYY-Www (2026-W42)',
  color: '#rrggbb (#1a2b3c)',
  range: 'a number within its min and max',
};

const SET_VALUE_INPUT_FN = `function(text) {
  const KINDS = ['time', 'date', 'datetime-local', 'month', 'week', 'color', 'range'];
  const isValueInput = (el) => el && el.tagName === 'INPUT' && KINDS.includes(el.type);
  const host = this.getRootNode && this.getRootNode().host;
  const input = isValueInput(this) ? this : isValueInput(host) ? host : null;
  if (!input) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let wanted = text.trim();
  if (input.type === 'time') {
    const m = /^(\\d{1,2})(?::(\\d{2}))?(?::(\\d{2}))?\\s*([ap])\\.?m?\\.?$/i.exec(wanted) || /^(\\d{1,2}):(\\d{2})(?::(\\d{2}))?()$/.exec(wanted);
    if (m) {
      let h = Number(m[1]);
      const ap = (m[4] || '').toLowerCase();
      if (ap === 'p' && h < 12) h += 12;
      if (ap === 'a' && h === 12) h = 0;
      wanted = pad(h) + ':' + (m[2] || '00') + (m[3] ? ':' + m[3] : '');
    }
  } else if (input.type === 'date' && !/^\\d{4}-\\d{2}-\\d{2}$/.test(wanted)) {
    const d = new Date(wanted);
    if (!isNaN(d)) wanted = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const segment = input !== this && !/[:\\-#T]/.test(wanted);
  if (segment) return { type: input.type, segment: true, ok: false, reads: input.value, wanted };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, wanted);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { type: input.type, segment: false, ok: input.value === wanted, reads: input.value, wanted };
}`;

/**
 * A closed native `<select>`'s options have no box to click, so choose the option as a user's pick
 * would (value plus input and change events). Returns its label, or undefined when not such an option.
 */
export async function chooseNativeOption(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number,
): Promise<string | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  if (!object.objectId) return undefined;
  try {
    const { result } = await cdp.send<{ result: { value?: string | null } }>(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const select = this.tagName === 'OPTION' ? this.closest('select') : null;
          if (!select) return null;
          select.value = this.value;
          this.selected = true;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return (this.label || this.textContent || '').trim();
        }`,
        returnByValue: true,
      },
      sessionId,
    );
    return result.value ?? undefined;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sessionId).catch(() => {});
  }
}

export async function nodeOrigin(cdp: CDPClient, sessionId: string, backendNodeId: number | undefined): Promise<string> {
  if (backendNodeId === undefined) return 'null';
  const { object } = await cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
  if (!object.objectId) return 'null';
  const { result } = await cdp.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { var w = this.ownerDocument && this.ownerDocument.defaultView; return w ? w.origin : "null"; }',
    returnByValue: true,
  }, sessionId);
  return typeof result.value === 'string' ? result.value : 'null';
}
