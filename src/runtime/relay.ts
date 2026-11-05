/**
 * `--device` over HTTPS, as argv, to a relay the unreachable device connects out to.
 * Without `BROWSER_RELAY_URL` and `BROWSER_RELAY_TOKEN` every route stays on ssh.
 */

export const RELAY_URL_ENV = 'BROWSER_RELAY_URL';
export const RELAY_TOKEN_ENV = 'BROWSER_RELAY_TOKEN';
const RELAY_TIMEOUT_MS = 100_000;

export interface Relay {
  url: string;
  token: string;
}

export interface RelayResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): Relay | null {
  const url = env[RELAY_URL_ENV]?.trim();
  if (!url) return null;
  const token = env[RELAY_TOKEN_ENV]?.trim();
  if (!token) throw new Error(`${RELAY_URL_ENV} is set but ${RELAY_TOKEN_ENV} is empty`);
  // The bearer rides every request, so only loopback may use plain http.
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) {
    throw new Error(`${RELAY_URL_ENV} must be an https URL (http only on loopback), got ${JSON.stringify(url)}`);
  }
  return { url: url.replace(/\/+$/, ''), token };
}

async function post(relay: Relay, device: string, op: 'exec' | 'file', body: unknown): Promise<unknown> {
  const response = await fetch(`${relay.url}/${encodeURIComponent(device)}/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // Past the relay's own 90 s device wait, so its typed DEVICE_TIMEOUT arrives before this fires.
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error(`Relay answered ${response.status} with a non-JSON body for device "${device}"`);
  }
  if (!response.ok) {
    const error = (decoded as { error?: { code?: string; message?: string } }).error;
    throw new Error(`${error?.code ?? `HTTP_${response.status}`}: ${error?.message ?? 'relay refused the request'}`);
  }
  return decoded;
}

/** Run `browser <argv>` on `device` through the relay and return its exit code and output. */
export async function relayExec(
  relay: Relay,
  device: string,
  argv: string[],
  env: Record<string, string>,
): Promise<RelayResult> {
  const words = argv[0] === 'browser' ? argv.slice(1) : argv;
  const result = await post(relay, device, 'exec', { argv: words, env }) as Partial<RelayResult>;
  if (typeof result.code !== 'number') throw new Error(`Relay returned no exit code for device "${device}"`);
  return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Fetch a file the forwarded verb wrote on `device` (a screenshot, a PDF). */
export async function relayFetchFile(relay: Relay, device: string, remotePath: string): Promise<Buffer> {
  const result = await post(relay, device, 'file', { path: remotePath }) as { base64?: unknown };
  if (typeof result.base64 !== 'string') throw new Error(`Relay returned no file body for ${device}:${remotePath}`);
  return Buffer.from(result.base64, 'base64');
}
