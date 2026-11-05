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

export async function readAndResolveBundleEnv(
  name: string,
  _opts?: { caller?: string; agentOnly?: boolean; keys?: string[]; keyMode?: string },
): Promise<{ env: Record<string, string> }> {
  const res = spawnSync('secrets', ['export', name, '--json'], { encoding: 'utf-8', timeout: 15000 });
  if (res.status !== 0) {
    throw new Error(`Could not resolve secrets bundle ${JSON.stringify(name)}. Install @phnx-labs/secrets-cli or unset the profile secrets binding.`);
  }
  const parsed = JSON.parse(res.stdout || '{}') as unknown;
  const env: Record<string, string> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
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
