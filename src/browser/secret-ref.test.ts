import { describe, it, expect } from 'bun:test';
import { parseSecretRef, secretSite, onSecretSite } from './secret-ref.js';

describe('parseSecretRef', () => {
  it('parses <bundle>/<KEY>', () => {
    expect(parseSecretRef('logins/GITHUB_PASSWORD')).toEqual({ bundle: 'logins', key: 'GITHUB_PASSWORD' });
  });

  it('accepts an optional secret: prefix', () => {
    expect(parseSecretRef('secret:logins/GITHUB_PASSWORD')).toEqual({ bundle: 'logins', key: 'GITHUB_PASSWORD' });
  });

  it('keeps slashes inside the key (only the first slash splits)', () => {
    expect(parseSecretRef('b/a/b/c')).toEqual({ bundle: 'b', key: 'a/b/c' });
  });

  it('rejects malformed refs', () => {
    expect(parseSecretRef('nokey')).toBeNull();
    expect(parseSecretRef('/leadingslash')).toBeNull();
    expect(parseSecretRef('trailing/')).toBeNull();
    expect(parseSecretRef('')).toBeNull();
    expect(parseSecretRef('secret:')).toBeNull();
  });
});

describe('secret site binding', () => {
  it('reads the site from a bundle named after one', () => {
    expect(secretSite('stripe.com')).toBe('stripe.com');
    expect(secretSite('Accounts.Google.com')).toBe('accounts.google.com');
    expect(secretSite('logins')).toBeNull();
  });

  it('allows the site and its subdomains, nothing else', () => {
    expect(onSecretSite('https://stripe.com/login', 'stripe.com')).toBe(true);
    expect(onSecretSite('https://dashboard.stripe.com/x', 'stripe.com')).toBe(true);
    expect(onSecretSite('https://stripe-billing-help.io/login', 'stripe.com')).toBe(false);
    expect(onSecretSite('https://stripe.com.evil.io/', 'stripe.com')).toBe(false);
    expect(onSecretSite('https://evilstripe.com/', 'stripe.com')).toBe(false);
    expect(onSecretSite('about:blank', 'stripe.com')).toBe(false);
  });
});
