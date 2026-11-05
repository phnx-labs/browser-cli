import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The skill installed with the binary: `../skills` beside its `bin/`, else
 * `BROWSER_SKILLS_DIR`, set by the JavaScript launcher or by hand for a dev build.
 */
export const SKILLS_DIR_ENV = 'BROWSER_SKILLS_DIR';

export class BrowserSkillsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSkillsUnavailableError';
  }
}

/** The installed `skills/browser/` directory. Throws when it cannot be located. */
export function browserSkillDir(): string {
  const root = packagedSkillsDir() ?? process.env[SKILLS_DIR_ENV];
  if (!root) {
    throw new BrowserSkillsUnavailableError(
      `${SKILLS_DIR_ENV} is not set. Run browser from its npm package, or set ${SKILLS_DIR_ENV} to the package's skills/ directory.`,
    );
  }
  const dir = path.join(root, 'browser');
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new BrowserSkillsUnavailableError(`No browser skill at ${dir} (${SKILLS_DIR_ENV}=${root}).`);
  }
  return dir;
}

/** `<package>/skills` when this binary is the one installed at `<package>/bin/`; an inherited variable cannot replace it. */
function packagedSkillsDir(): string | undefined {
  let exe: string;
  try {
    exe = fs.realpathSync(process.execPath);
  } catch {
    return undefined;
  }
  const root = path.join(path.dirname(exe), '..', 'skills');
  return fs.existsSync(path.join(root, 'browser', 'SKILL.md')) ? root : undefined;
}

/** Site guides: `skills/browser/references/sites/<site>.md`. */
export function siteGuidesDir(): string {
  return path.join(browserSkillDir(), 'references', 'sites');
}

export interface SkillDocument {
  /** `browser` for SKILL.md, else the reference path without `.md`, e.g. `arc`, `sites/slack`. */
  name: string;
  path: string;
}

/** SKILL.md first, then every reference document, sorted. */
export function listSkillDocuments(): SkillDocument[] {
  const dir = browserSkillDir();
  const docs: SkillDocument[] = [{ name: 'browser', path: path.join(dir, 'SKILL.md') }];
  const refs = path.join(dir, 'references');
  const walk = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(refs, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) docs.push({ name: rel.slice(0, -3), path: path.join(refs, rel) });
    }
  };
  if (fs.existsSync(refs)) walk('');
  return docs;
}

/** Resolve `browser`, `arc`, `sites/slack` or a bare site name like `slack`. */
export function findSkillDocument(name: string): SkillDocument {
  const docs = listSkillDocuments();
  const hit = docs.find((d) => d.name === name) ?? docs.find((d) => d.name === `sites/${name}`);
  if (!hit) {
    throw new BrowserSkillsUnavailableError(
      `No skill document "${name}". Available: ${docs.map((d) => d.name).join(', ')}`,
    );
  }
  return hit;
}
