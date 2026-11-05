// Site guides for `browser start --url`: `skills/browser/references/sites/<site>.md`,
// printed so the agent reads the site's gotchas first. Frontmatter `domains: [a, b]`
// wins; otherwise the file name matches a host label (`app.slack.com` → `slack.md`).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { siteGuidesDir } from '../runtime/skills.js';

export interface SiteGuide {
  /** File name without `.md`, e.g. `slack`. */
  name: string;
  path: string;
  content: string;
  /** Hostname the match was made against (`www.` stripped). */
  hostname: string;
}

/**
 * Match candidates for a hostname, most specific first:
 * `app.slack.com` → ['app.slack.com', 'slack.com', 'slack', 'app'].
 */
export function hostnameMatchCandidates(hostname: string): string[] {
  const cleaned = hostname.toLowerCase().replace(/^www\./, '');
  if (!cleaned) return [];
  const parts = cleaned.split('.').filter(Boolean);
  const out = new Set<string>([cleaned]);
  // Stop before the bare TLD: a guide named `com` must not match every .com site.
  for (let i = 1; i < parts.length - 1; i++) out.add(parts.slice(i).join('.'));
  if (parts.length >= 2) {
    out.add(parts[parts.length - 2]);
    out.add(parts[0]);
  }
  return Array.from(out);
}

/** A guide's frontmatter `domains:` list, inline (`[a, b]`) or block (`- a`). */
export function parseDomains(content: string): string[] {
  if (!content.startsWith('---')) return [];
  const end = content.indexOf('\n---', 3);
  if (end < 0) return [];
  const fm = content.slice(3, end);
  const clean = (s: string) => s.trim().replace(/^["']|["']$/g, '').toLowerCase();
  const inline = fm.match(/^domains:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(',').map(clean).filter(Boolean);
  const block = fm.match(/^domains:\s*\n((?:\s+-\s+\S+\n?)+)/m);
  if (block) return block[1].split('\n').map((l) => clean(l.replace(/^\s*-\s*/, ''))).filter(Boolean);
  return [];
}

/**
 * The guide for `url`'s host, or null (also for an invalid URL). Throws
 * `BrowserSkillsUnavailableError` when the skill itself cannot be located.
 */
export function resolveSiteGuide(url: string): SiteGuide | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const candidates = hostnameMatchCandidates(hostname);
  if (candidates.length === 0) return null;

  const dir = siteGuidesDir();
  if (!fs.existsSync(dir)) return null;
  const guides = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const content = fs.readFileSync(file, 'utf8');
      return { name: f.slice(0, -3), path: file, content, domains: parseDomains(content) };
    });

  const wanted = new Set(candidates);
  const pinned = guides.find((g) => g.domains.some((d) => wanted.has(d)));
  if (pinned) return { name: pinned.name, path: pinned.path, content: pinned.content, hostname };
  for (const c of candidates) {
    const hit = guides.find((g) => g.name.toLowerCase() === c);
    if (hit) return { name: hit.name, path: hit.path, content: hit.content, hostname };
  }
  return null;
}
