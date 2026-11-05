// What each npm tarball may contain. release.mjs refuses to publish anything else.
// The launcher package also ships the browser skill (skills/browser/**).
const LAUNCHER = new Set(['package.json', 'bin/browser.cjs', 'bin/install.cjs', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const PLATFORM = new Set(['package.json', 'browser', 'browser.exe', 'LICENSE']);

/** True when `file` (a path from `npm pack --json`) may ship in the launcher (`launcher: true`) or a platform package. */
export function isPublishedFileAllowed(file, { launcher }) {
  if (!launcher) return PLATFORM.has(file);
  return LAUNCHER.has(file) || file.startsWith('skills/browser/');
}
