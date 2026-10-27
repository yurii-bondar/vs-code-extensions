// The parts of Go To Project that do not need VS Code, so they can be tested with plain Node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Like JetBrains project icons: up to two initials ("shop-admin-panel" → "SA") on a colour picked from the name.
const PALETTE = ['#4D8FE8', '#3FB27F', '#E8804D', '#B36BE0', '#E05C7A', '#2FAFB8', '#C9A227', '#7A86E8', '#5FA855', '#D96C4F'];

function initials(name) {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return letters.toUpperCase();
}

function iconColor(name) {
  return PALETTE[crypto.createHash('sha1').update(name).digest()[0] % PALETTE.length];
}

function iconSvg(text, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="21.5" text-anchor="middle" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${text.length > 1 ? 14 : 16}" font-weight="700" fill="#fff">${text}</text></svg>`;
}

/** The git dir for `dir` or one of its parents; follows the `gitdir:` file of worktrees and submodules. */
function resolveGitDir(dir) {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const dotGit = path.join(cur, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (m) return path.resolve(cur, m[1].trim());
    } catch {
      // not here, keep walking up
    }
    if (path.dirname(cur) === cur) return undefined;
  }
}

/** Branch name from a git dir's HEAD, the short hash when detached; undefined when there is no git. */
function readBranch(dir) {
  const gitDir = resolveGitDir(dir);
  if (!gitDir) return undefined;
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  const branch = m ? m[1] : head.slice(0, 7);
  return gitDir.includes(`${path.sep}worktrees${path.sep}`) ? `${branch} (worktree)` : branch;
}

function tildify(location, home) {
  return location.startsWith(home + path.sep) ? `~${location.slice(home.length)}` : location;
}

function isUnder(p, dirs) {
  return dirs.some((dir) => p === dir || p.startsWith(dir + path.sep));
}

/** Open windows with the one focused before this one first, so Enter jumps straight back. */
function previousFirst(uris, previous) {
  return [...uris].sort((a, b) => Number(b.toString() === previous) - Number(a.toString() === previous));
}

module.exports = { initials, iconColor, iconSvg, resolveGitDir, readBranch, tildify, isUnder, previousFirst };
