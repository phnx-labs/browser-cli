import type { NetworkRequest } from './types.js';

/**
 * Minimal HAR 1.2 shapes (http://www.softwareishard.com/blog/har-12-spec/). Fields the
 * buffer cannot back get the spec's empty defaults or `-1`, so validators accept it.
 */
export interface HarLog {
  version: '1.2';
  creator: { name: string; version: string };
  pages: HarPage[];
  entries: HarEntry[];
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: never[];
  headers: never[];
  queryString: Array<{ name: string; value: string }>;
  headersSize: number;
  bodySize: number;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: never[];
  headers: never[];
  content: { size: number; mimeType: string; text?: string };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarTimings {
  send: number;
  wait: number;
  receive: number;
}

export interface BuildHarOptions {
  creatorName?: string;
  creatorVersion?: string;
}

/**
 * Serialize buffered requests to HAR 1.2. Only url/method/status/mimeType/timestamp are
 * known; sizes and timings are `-1`, cookies and headers empty, as for opaque responses.
 */
export function buildHar(
  requests: NetworkRequest[],
  opts: BuildHarOptions = {}
): { log: HarLog } {
  const creator = {
    name: opts.creatorName ?? 'browser-cli',
    version: opts.creatorVersion ?? '',
  };

  const startedAt = requests.length > 0 ? Math.min(...requests.map((r) => r.timestamp)) : Date.now();

  const page: HarPage = {
    startedDateTime: new Date(startedAt).toISOString(),
    id: 'page_1',
    title: 'browser session',
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  };

  const entries: HarEntry[] = requests.map((r) => {
    const queryString = extractQueryString(r.url);
    const mimeType = r.mimeType ?? '';
    return {
      startedDateTime: new Date(r.timestamp).toISOString(),
      time: -1,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        queryString,
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: r.status ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        content: { size: -1, mimeType },
        redirectURL: '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
    };
  });

  return {
    log: {
      version: '1.2',
      creator,
      pages: [page],
      entries,
    },
  };
}

/** `?a=1&b=2` as HAR's `queryString`; `[]` when absent or unparsable (e.g. `data:` URLs). */
function extractQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const out: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((value, name) => out.push({ name, value }));
    return out;
  } catch {
    return [];
  }
}
