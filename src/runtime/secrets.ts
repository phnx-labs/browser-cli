import { spawnSync } from 'node:child_process';

export interface SecretsBundle {
  name: string;
  items?: Record<string, string>;
  vars: Record<string, string>;
}

export async function bundleExists(name: string): Promise<boolean> {
  const res = spawnSync('secrets', ['view', name, '--json'], { encoding: 'utf-8', timeout: 8000 });
  return res.status === 0;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The key names a bundle holds, from `secrets view --json` (values stay masked there). */
function bundleKeys(name: string): string[] {
  const res = spawnSync('secrets', ['view', name, '--json'], { encoding: 'utf-8', timeout: 8000 });
  if (res.status !== 0) return [];
  const parsed = JSON.parse(res.stdout || '{}') as { keys?: Array<{ key?: unknown }> };
  return (parsed.keys ?? []).map((k) => k.key).filter((k): k is string => typeof k === 'string');
}

/**
 * Resolve a bundle's values through `secrets exec`, the CLI's one way to hand values to a process:
 * the child prints each requested variable NUL-separated, read by name from its own environment so
 * no value is ever interpolated into a command line.
 */
export async function readAndResolveBundleEnv(
  name: string,
  opts: { caller?: string; agentOnly?: boolean; keys?: string[]; keyMode?: string } = {},
): Promise<{ env: Record<string, string> }> {
  const keys = (opts.keys ?? bundleKeys(name)).filter((k) => ENV_KEY.test(k));
  if (keys.length === 0) return { env: {} };
  const printer = process.platform === 'win32'
    ? ['powershell', '-NoProfile', '-Command', 'foreach($k in $args){[Console]::Out.Write([Environment]::GetEnvironmentVariable($k)+[char]0)}', ...keys]
    : ['awk', 'BEGIN{for(i=1;i<ARGC;i++) printf "%s%c", ENVIRON[ARGV[i]], 0}', ...keys];
  const res = spawnSync('secrets', ['exec', name, '--keys', keys.join(','), '--', ...printer], { encoding: 'utf-8', timeout: 15000 });
  if (res.status !== 0) {
    const why = (res.stderr || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(why
      ? `Could not read ${keys.join(', ')} from secrets bundle ${JSON.stringify(name)}: ${why}`
      : `Could not resolve secrets bundle ${JSON.stringify(name)}. Install @phnx-labs/secrets-cli or unset the profile secrets binding.`);
  }
  const values = res.stdout.split('\0');
  const env: Record<string, string> = {};
  keys.forEach((k, i) => {
    if (values[i] !== undefined) env[k] = values[i];
  });
  return { env };
}

export async function readBundle(name: string): Promise<SecretsBundle> {
  const { env } = await readAndResolveBundleEnv(name);
  return { name, items: env, vars: env };
}

export function secretsKeychainItem(): never {
  throw new Error('Direct keychain access is not available in browser-cli; use the secrets CLI.');
}

export function writeBundleWithItems(): never {
  throw new Error('Writing secrets is not available in browser-cli; use the secrets CLI.');
}

export function _resetSecretsClientForTest(): void {
}
