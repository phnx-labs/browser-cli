/**
 * Parse the `[secret:]<bundle>/<KEY>` reference `browser type --secret` uses to type
 * a credential without the value crossing stdout or the transcript. Null if malformed.
 */
export function parseSecretRef(ref: string): { bundle: string; key: string } | null {
  const body = ref.startsWith('secret:') ? ref.slice('secret:'.length) : ref;
  const slash = body.indexOf('/');
  // Need a non-empty bundle before the slash and a non-empty key after it.
  if (slash <= 0 || slash >= body.length - 1) return null;
  return { bundle: body.slice(0, slash), key: body.slice(slash + 1) };
}

export function secretSite(bundle: string): string | null {
  const name = bundle.toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null;
}

export function onSecretSite(url: string, site: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === site || host.endsWith('.' + site);
}

export function assertSecretSite(site: string, origin: string): void {
  if (onSecretSite(origin, site)) return;
  const where = URL.canParse(origin) ? new URL(origin).hostname || origin : origin;
  throw new Error([
    `Refused: this secret types only into ${site}, and the field is on ${where}. Nothing was typed.`,
    `Next: browser navigate https://${site}  |  browser tabs`,
  ].join('\n'));
}
