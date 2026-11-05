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
