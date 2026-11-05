import type { CDPClient } from './cdp.js';

/** One document whose accessibility tree is listed: the page, a same-site iframe, or a cross-site iframe. */
export interface FrameScope {
  sessionId: string;
  frameId?: string;
  /** Cross-site iframes only: the frame's own target and the page's `<iframe>` element that holds it. */
  targetId?: string;
  frameOwner?: number;
  url?: string;
  /** The page's own scope only: the top document's loader id, which a same-document (router) navigation keeps. */
  document?: string;
}

const iframeSessions = new WeakMap<CDPClient, Map<string, string>>();

async function iframeSession(cdp: CDPClient, targetId: string, fresh = false): Promise<string> {
  let sessions = iframeSessions.get(cdp);
  if (!sessions) iframeSessions.set(cdp, (sessions = new Map()));
  const cached = sessions.get(targetId);
  if (cached && !fresh) return cached;
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  sessions.set(targetId, sessionId);
  return sessionId;
}

/**
 * Send to a frame's document. A cross-site frame's session can be detached by another client while
 * its target lives on, so one failure re-attaches and retries; the scope keeps the working session.
 */
export async function sendToFrame<T>(cdp: CDPClient, scope: FrameScope, method: string, params: Record<string, unknown>): Promise<T> {
  try {
    return await cdp.send<T>(method, params, scope.sessionId);
  } catch (err) {
    if (!scope.targetId) throw err;
    scope.sessionId = await iframeSession(cdp, scope.targetId, true);
    return cdp.send<T>(method, params, scope.sessionId);
  }
}

/**
 * The page plus every iframe an agent can act on: same-site frames by frameId on the page session,
 * cross-site frames as their own targets, placed by the `<iframe>` element that owns each one.
 */
export async function frameScopes(cdp: CDPClient, sessionId: string): Promise<FrameScope[]> {
  const scopes: FrameScope[] = [{ sessionId }];
  const pageFrames = new Set<string>();
  try {
    const { frameTree } = await cdp.send<{ frameTree: FrameTreeNode }>('Page.getFrameTree', {}, sessionId);
    pageFrames.add(frameTree.frame.id);
    scopes[0]!.document = frameTree.frame.loaderId;
    const walk = (node: FrameTreeNode): void => {
      for (const child of node.childFrames ?? []) {
        pageFrames.add(child.frame.id);
        scopes.push({ sessionId, frameId: child.frame.id, url: child.frame.url });
        walk(child);
      }
    };
    walk(frameTree);
  } catch {
    // A target without the Page domain (a worker) has no frames to list.
  }
  try {
    const { targetInfos } = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string; parentFrameId?: string }>;
    }>('Target.getTargets', {});
    // Chromium without parentFrameId (older than ~120): ask the page about every iframe target.
    const ours = (t: { parentFrameId?: string }) => t.parentFrameId === undefined || pageFrames.has(t.parentFrameId);
    for (const info of targetInfos.filter((t) => t.type === 'iframe' && ours(t))) {
      const owner = await cdp
        .send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: info.targetId }, sessionId)
        .catch(() => undefined);
      if (!owner) continue;
      scopes.push({ sessionId: await iframeSession(cdp, info.targetId), targetId: info.targetId, frameOwner: owner.backendNodeId, url: info.url });
    }
  } catch {
    // Listing cross-site frames is best effort; the page's own tree is already in hand.
  }
  return scopes;
}

interface FrameTreeNode {
  frame: { id: string; url: string; loaderId?: string };
  childFrames?: FrameTreeNode[];
}

/**
 * The text a reader sees: the page's innerText, then each iframe's under a
 * `--- iframe <url> ---` line. A frame that cannot be read is skipped.
 */
export async function pageText(cdp: CDPClient, sessionId: string): Promise<string> {
  const parts: string[] = [];
  for (const scope of await frameScopes(cdp, sessionId)) {
    let contextId: number | undefined;
    if (scope.frameId) {
      const world = await cdp
        .send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: scope.frameId, worldName: 'browser-cli-text' }, sessionId)
        .catch(() => undefined);
      if (!world) continue;
      contextId = world.executionContextId;
    }
    const evaluated = await sendToFrame<{ result: { value?: string } }>(cdp, scope, 'Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
      ...(contextId ? { contextId } : {}),
    }).catch(() => undefined);
    const text = evaluated?.result.value?.trim();
    if (!text) continue;
    parts.push(scope.url === undefined ? text : `--- iframe ${scope.url} ---\n${text}`);
  }
  return parts.join('\n\n');
}
