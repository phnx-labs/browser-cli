import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostnameMatchCandidates, parseDomains, resolveSiteGuide } from './site-guides.js';
import { BrowserSkillsUnavailableError } from '../runtime/skills.js';

const SKILLS = join(import.meta.dir, '..', '..', 'skills');
const saved = process.env.BROWSER_SKILLS_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.BROWSER_SKILLS_DIR;
  else process.env.BROWSER_SKILLS_DIR = saved;
});

describe('site guides', () => {
  it('match the shipped guides by host', () => {
    process.env.BROWSER_SKILLS_DIR = SKILLS;
    expect(resolveSiteGuide('https://app.slack.com/client/T1/C1')?.name).toBe('slack');
    expect(resolveSiteGuide('https://www.linkedin.com/in/someone/')?.name).toBe('linkedin');
    expect(resolveSiteGuide('https://www.perplexity.ai/search/x')?.name).toBe('perplexity');
    expect(resolveSiteGuide('https://example.com/')).toBeNull();
    expect(resolveSiteGuide('not a url')).toBeNull();
  });

  it('a domains: pin wins over a file-name match', () => {
    const root = mkdtempSync(join(tmpdir(), 'site-guides-'));
    try {
      const sites = join(root, 'browser', 'references', 'sites');
      mkdirSync(sites, { recursive: true });
      writeFileSync(join(root, 'browser', 'SKILL.md'), '---\nname: browser\ndescription: x\n---\n');
      writeFileSync(join(sites, 'google.md'), '# google\n');
      writeFileSync(join(sites, 'gmail.md'), '---\ndomains: [mail.google.com]\n---\n# gmail\n');
      process.env.BROWSER_SKILLS_DIR = root;
      expect(resolveSiteGuide('https://mail.google.com/mail/u/0/')?.name).toBe('gmail');
      expect(resolveSiteGuide('https://docs.google.com/')?.name).toBe('google');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throw when the skill cannot be located, rather than reporting no guide', () => {
    delete process.env.BROWSER_SKILLS_DIR;
    expect(() => resolveSiteGuide('https://app.slack.com/')).toThrow(BrowserSkillsUnavailableError);
  });

  it('derive host candidates and parse both domains: forms', () => {
    expect(hostnameMatchCandidates('app.slack.com')).toEqual(['app.slack.com', 'slack.com', 'slack', 'app']);
    expect(parseDomains('---\ndomains: [A.com, "b.com"]\n---\n')).toEqual(['a.com', 'b.com']);
    expect(parseDomains('---\ndomains:\n  - a.com\n  - b.com\n---\n')).toEqual(['a.com', 'b.com']);
    expect(parseDomains('# no frontmatter')).toEqual([]);
  });
});
