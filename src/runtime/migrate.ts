import * as fs from 'node:fs';
import * as path from 'node:path';

function copyDirSkipExisting(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSkipExisting(from, to);
      continue;
    }
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
}

function moveDirOnce(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.renameSync(src, dest);
      return;
    } catch { /* fall through */ }
  }
  try {
    copyDirSkipExisting(src, dest);
    fs.rmSync(src, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

function rmEmptyDirTree(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const child = path.join(dir, entry);
      try {
        if (fs.statSync(child).isDirectory()) rmEmptyDirTree(child);
      } catch { /* skip */ }
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best-effort */ }
}

export function foldBrowserSessionsIntoProfiles(browserDir: string): void {
  const legacySessionsDir = path.join(browserDir, 'sessions');
  let taskDirs: fs.Dirent[];
  try {
    taskDirs = fs.readdirSync(legacySessionsDir, { withFileTypes: true });
  } catch {
    return;
  }

  const taskOwner = new Map<string, string>();
  let profileDirs: fs.Dirent[] = [];
  try {
    profileDirs = fs.readdirSync(browserDir, { withFileTypes: true });
  } catch { /* vanished */ }
  for (const p of profileDirs) {
    if (!p.isDirectory() || p.name === 'sessions' || p.name === '_legacy') continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(browserDir, p.name, 'tasks.json'), 'utf-8'));
      for (const taskName of Object.keys(state)) {
        if (!taskOwner.has(taskName)) taskOwner.set(taskName, p.name);
      }
    } catch { /* missing or invalid */ }
  }

  for (const taskEntry of taskDirs) {
    if (!taskEntry.isDirectory()) continue;
    const owner = taskOwner.get(taskEntry.name) ?? '_legacy';
    moveDirOnce(
      path.join(legacySessionsDir, taskEntry.name),
      path.join(browserDir, owner, 'sessions', taskEntry.name),
    );
  }

  rmEmptyDirTree(legacySessionsDir);
}
