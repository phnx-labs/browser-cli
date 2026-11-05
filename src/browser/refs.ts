import type { CDPClient } from './cdp.js';
import { frameScopes, sendToFrame } from './frames.js';
import { truncate } from '@phnx-labs/tui';

export interface RefOpts {
  interactive?: boolean;
  limit?: number;
  compact?: boolean;
}

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface RefNode {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  backendNodeId?: number;
  /** Stable selector used by non-CDP DOM backends such as native Arc. */
  selector?: string;
  editor?: string;
  /** CDP session of the frame the node lives in, when it is a cross-site iframe (its own target). */
  sessionId?: string;
  /** That iframe's `<iframe>` element in the page, scrolled into view before a click. */
  frameOwner?: number;
  /** URL of the iframe the node is in; absent for the page itself. */
  frame?: string;
  /** Top-frame nodes: the loader id of the document they were listed in (see {@link refStillMatches}). */
  document?: string;
}

/**
 * A ref's navigation-surviving identity: no `backendNodeId`, only the accessible descriptor a later
 * `click <ref>` re-matches against a fresh `getRefs` when the integer ref drifted ({@link healRef}).
 */
export interface RefDescriptor {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  /** URL of the iframe the ref was listed in, so a heal never jumps to a twin in another frame. */
  frame?: string;
  /** Best-effort CSS selector, unused so far: healing matches role, name, attrs and position. */
  selector?: string;
}

/**
 * A tab's cached ref listing and the {@link RefOpts} it was built with. A later `click`/`type` must
 * rebuild with the same opts, or its refs are numbered against a different filter than the user saw.
 */
export interface RefSnapshot {
  descriptors: RefDescriptor[];
  opts: { interactive: boolean; limit: number };
}

/** Snapshot the stable descriptor for every ref in a freshly-built node map. */
export function describeRefs(nodeMap: Map<number, RefNode>): RefDescriptor[] {
  return Array.from(nodeMap.values()).map((n) => ({
    ref: n.ref,
    role: n.role,
    name: n.name,
    attrs: n.attrs.slice(),
    ...(n.frame !== undefined ? { frame: n.frame } : {}),
    selector: n.selector,
  }));
}

/**
 * The fresh ref for a stale descriptor, or `null` when no node shares its role and name. Duplicates
 * tie-break by DOM-backed first, then attribute similarity, then nearest to the original index.
 */
export function healRef(
  descriptor: Pick<RefDescriptor, 'ref' | 'role' | 'name' | 'attrs' | 'frame'>,
  freshNodeMap: Map<number, RefNode>
): number | null {
  const { ref, role, name, attrs, frame } = descriptor;
  const cachedAttrs = new Set(attrs);

  // How well a candidate's attribute set matches the cached one: reward shared
  // attrs, penalize both extras the candidate carries and cached attrs it is
  // missing. Exact set equality scores highest; an all-attrs-empty comparison
  // scores 0 for every candidate (so the tie-break falls through to proximity).
  const attrScore = (node: RefNode): number => {
    let shared = 0;
    for (const a of node.attrs) if (cachedAttrs.has(a)) shared += 1;
    const extra = node.attrs.length - shared;
    const missing = cachedAttrs.size - shared;
    return shared * 2 - extra - missing;
  };

  let best: RefNode | null = null;
  let bestKey: number[] | null = null;
  for (const node of freshNodeMap.values()) {
    if (node.role !== role || node.name !== name) continue;
    // Lexicographic key, all "higher is better":
    //   [ same frame, DOM-backed, attribute similarity, -distance-to-original-ref ].
    // Two iframes can hold identical controls (one quiz per frame); a heal
    // must stay in the frame the caller saw.
    const key = [
      node.frame === frame ? 1 : 0,
      node.backendNodeId !== undefined || node.selector !== undefined ? 1 : 0,
      attrScore(node),
      -Math.abs(node.ref - ref),
    ];
    const better = bestKey === null || (() => {
      for (let i = 0; i < key.length; i++) if (key[i] !== bestKey![i]) return key[i]! > bestKey![i]!;
      return false;
    })();
    if (better) {
      best = node;
      bestKey = key;
    }
  }
  return best ? best.ref : null;
}

const EDITOR_DETECT_FN = `(function() {
  let el = this;
  for (let i = 0; i < 5; i++) {
    if (!el || el === document.documentElement) break;
    if (el.hasAttribute && el.hasAttribute('data-lexical-editor')) return 'lexical';
    if (el.classList && el.classList.contains('ProseMirror')) return 'prosemirror';
    if (el.hasAttribute && el.hasAttribute('data-slate-editor')) return 'slate';
    if (el.classList && Array.from(el.classList).some(function(c) { return /^DraftEditor-/.test(c); })) return 'draft';
    if (el.classList && el.classList.contains('ql-editor')) return 'quill';
    if (el.classList && el.classList.contains('ck-editor__editable')) return 'ckeditor5';
    if (el.tagName === 'TRIX-EDITOR') return 'trix';
    el = el.parentElement;
  }
  return null;
})`;

async function detectEditorForNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<string | undefined> {
  const { object } = await cdp.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId },
    sessionId
  );
  if (!object.objectId) return undefined;
  const objectId = object.objectId;
  try {
    const { result } = await cdp.send<{ result: { value: string | null } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: EDITOR_DETECT_FN, returnByValue: true },
      sessionId
    );
    return result.value ?? undefined;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }, sessionId);
  }
}

// The editor roots EDITOR_DETECT_FN recognizes, as one selector. The per-textbox ancestor walk
// costs three CDP round trips each (~260ms on a 400-field page), so it only runs when the page,
// asked once, has such a root in the document or an open shadow root.
const EDITOR_ROOTS_PRESENT_EXPR = `(function() {
  var sel = '[data-lexical-editor],.ProseMirror,[data-slate-editor],[class^="DraftEditor-"],[class*=" DraftEditor-"],.ql-editor,.ck-editor__editable,trix-editor';
  var found = false;
  var walk = function(root) {
    if (found) return;
    if (root.querySelector(sel)) { found = true; return; }
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length && !found; i++) if (all[i].shadowRoot) walk(all[i].shadowRoot);
  };
  walk(document);
  return found;
})()`;

async function pageHasEditorRoots(cdp: CDPClient, sessionId: string): Promise<boolean> {
  const { result } = await cdp.send<{ result: { value: boolean } }>(
    'Runtime.evaluate',
    { expression: EDITOR_ROOTS_PRESENT_EXPR, returnByValue: true },
    sessionId
  );
  return result.value === true;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'slider',
  'spinbutton',
  'searchbox',
  'switch',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  // Chromium's own roles for <input type=time|date|datetime-local|color>: listed
  // whole so a caller types "19:45" into one ref instead of hours, minutes and
  // AM/PM separately.
  'inputtime',
  'date',
  'datetime',
  'colorwell',
]);

export async function getRefs(
  cdp: CDPClient,
  sessionId: string,
  opts: RefOpts = {}
): Promise<{
  refs: string;
  nodeMap: Map<number, RefNode>;
  opts: { interactive: boolean; limit: number };
}> {
  const { interactive = true, limit = 500, compact = false } = opts;

  const nodeMap = new Map<number, RefNode>();
  const scopeOf = new Map<number, number>();
  let refCounter = 1;

  const scopes = await frameScopes(cdp, sessionId);
  for (const [scopeIndex, scope] of scopes.entries()) {
    if (refCounter > limit) break;
    let nodes: AXNode[];
    try {
      ({ nodes } = await sendToFrame<{ nodes: AXNode[] }>(
        cdp,
        scope,
        'Accessibility.getFullAXTree',
        scope.frameId ? { frameId: scope.frameId } : {}
      ));
    } catch (err) {
      if (scope.sessionId === sessionId && !scope.frameId) throw err;
      continue;
    }

    for (const node of nodes) {
      if (refCounter > limit) break;

      const role = node.role?.value?.toLowerCase() || '';
      if (!role || role === 'none' || role === 'generic') continue;
      if (interactive && !INTERACTIVE_ROLES.has(role)) continue;

      const name = node.name?.value || '';
      const attrs: string[] = [];

      for (const prop of node.properties || []) {
        const propName = prop.name;
        const propValue = prop.value?.value;
        if (propName === 'disabled' && propValue === true) attrs.push('disabled');
        if (propName === 'checked' && propValue === true) attrs.push('checked');
        if (propName === 'selected' && propValue === true) attrs.push('selected');
        if (propName === 'expanded' && propValue === true) attrs.push('expanded');
        if (propName === 'required' && propValue === true) attrs.push('required');
        if (propName === 'readonly' && propValue === true) attrs.push('readonly');
        if (propName === 'invalid' && propValue === true) attrs.push('invalid');
      }

      const ref = refCounter++;
      const refNode: RefNode = { ref, role, name, attrs, backendNodeId: node.backendDOMNodeId };
      if (scope.frameOwner !== undefined) {
        refNode.sessionId = scope.sessionId;
        refNode.frameOwner = scope.frameOwner;
      }
      if (scope.url !== undefined) refNode.frame = scope.url;
      if (scope.document !== undefined) refNode.document = scope.document;
      nodeMap.set(ref, refNode);
      scopeOf.set(ref, scopeIndex);
    }
  }

  const textboxes = [...nodeMap.values()].filter((n) => n.role === 'textbox' && n.backendNodeId && !n.sessionId);
  if (textboxes.length > 0 && (await pageHasEditorRoots(cdp, sessionId))) {
    for (const refNode of textboxes) {
      const editor = await detectEditorForNode(cdp, sessionId, refNode.backendNodeId!);
      if (editor) refNode.editor = editor;
    }
  }

  const lines: string[] = [];
  // One header per frame, keyed by the frame itself: two adjacent iframes
  // with the same src (repeated widgets) still get a header each.
  let currentScope = 0;
  for (const refNode of nodeMap.values()) {
    const { ref, role, name, attrs } = refNode;
    const frame = refNode.frame;
    const scopeIndex = scopeOf.get(ref) ?? 0;
    if (scopeIndex !== currentScope) {
      if (frame !== undefined) lines.push(compact ? `iframe "${truncate(frame, 80)}"` : `- iframe "${truncate(frame, 80)}"`);
      currentScope = scopeIndex;
    }
    const indent = frame !== undefined ? '  ' : '';
    const attrStr = attrs.length > 0 ? ` [${attrs.join('] [')}]` : '';
    const editorStr = refNode.editor ? ` [editor=${refNode.editor}]` : '';
    const nameStr = name ? ` "${truncate(name, 50)}"` : '';
    const line = compact
      ? `${indent}${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`
      : `${indent}- ${role}${nameStr} [ref=${ref}]${attrStr}${editorStr}`;
    lines.push(line);
  }

  return { refs: lines.join('\n'), nodeMap, opts: { interactive, limit } };
}


export async function resolveRefToCoords(
  cdp: CDPClient,
  sessionId: string,
  nodeMap: Map<number, RefNode>,
  ref: number
): Promise<{ x: number; y: number; sessionId: string }> {
  const node = nodeMap.get(ref);
  if (!node) throw new Error(`Ref ${ref} not found`);
  if (!node.backendNodeId) throw new Error(`Ref ${ref} has no DOM node`);

  // Mouse events only land inside the viewport: an element below the fold
  // (or the cross-site iframe holding it) is scrolled into view first, or the
  // click reports success and hits nothing.
  if (node.frameOwner !== undefined) {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.frameOwner }, sessionId).catch(() => {});
  }
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, node.sessionId ?? sessionId).catch(() => {});

  const { model } = (await cdp.send(
    'DOM.getBoxModel',
    { backendNodeId: node.backendNodeId },
    node.sessionId ?? sessionId
  )) as { model: { content: number[] } };

  const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content;

  // A cross-site iframe's box is in its own viewport, and mouse events go to
  // its own session: sent to the page they only reach the frame while the tab
  // is the one being painted, and a background tab's click hits the <iframe>.
  return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4, sessionId: node.sessionId ?? sessionId };
}

/**
 * True when only numbers, or a count after the label's stem, changed ("Cart, 1 items" to "Cart,
 * empty"); "Delete Alice" to "Delete Bob" may be a recycled node meaning something else.
 */
export function sameLabelButCount(a: string, b: string): boolean {
  const shape = (s: string) => s.replace(/\d+(?:[.,]\d+)*/g, '#');
  if (/\d/.test(a) && /\d/.test(b) && shape(a) === shape(b)) return true;
  const stem = (s: string) => /^(.+?)\s*[,(:]\s*(.*)$/.exec(s);
  // A count is a number or "empty"-like word, with at most one noun after it.
  const count = (tail: string) => /^(?:\d+(?:[.,]\d+)*|no|zero|none|empty)(?:\s+\w+)?\)?$/i.test(tail);
  const [x, y] = [stem(a), stem(b)];
  return !!x && !!y && x[1] === y[1] && count(x[2]) && count(y[2]);
}

/**
 * The node's current name if a cached ref still points at the element the caller saw, via one
 * partial AX fetch instead of a full rebuild. A renamed node is trusted only in its listed document.
 */
export async function refStillMatches(
  cdp: CDPClient,
  sessionId: string,
  node: RefNode
): Promise<string | undefined> {
  if (!node.backendNodeId) return undefined;
  try {
    const { nodes } = await cdp.send<{ nodes: AXNode[] }>(
      'Accessibility.getPartialAXTree',
      { backendNodeId: node.backendNodeId, fetchRelatives: false },
      node.sessionId ?? sessionId
    );
    const live = nodes[0];
    if (!live || live.backendDOMNodeId !== node.backendNodeId) return undefined;
    const role = live.role?.value?.toLowerCase() || '';
    const name = live.name?.value || '';
    if (role !== node.role) return undefined;
    if (name === node.name) return name;
    if (!node.document || !sameLabelButCount(name, node.name)) return undefined;
    const { frameTree } = await cdp.send<{ frameTree: { frame: { loaderId?: string } } }>('Page.getFrameTree', {}, sessionId);
    return frameTree.frame.loaderId === node.document ? name : undefined;
  } catch {
    return undefined;
  }
}
