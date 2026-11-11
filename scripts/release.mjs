#!/usr/bin/env node
// Builds the extensions of this repo for release (.vsix), each versioned as semantic-release versions it in CI
// (release.config.base.cjs), while releases are made by hand:
//
// - The last release of each is its git tag: `<folder>-v<version>` (semantic-release-monorepo's name, e.g.
//   `scriptor-v0.1.0`). A target with no tag yet is skipped: tag the commit its published version was built from once.
// - The commits since then that touch its folders decide the next version, read by semantic-release's own commit
//   analyzer with the conventionalcommits preset: `feat` → minor, `fix`/`perf` → patch, `!` or `BREAKING CHANGE` → major,
//   `refactor`/`test`/`docs`/`chore`/`ci`/`build`/`style` → no release.
// - Nothing is built when a target's folders hold exactly what its last release held (their git tree hashes match),
//   or when no commit since then calls for a release. Hashes, not commit lists, so a squash merge or a rebase that
//   brings the same content is no new release.
// - A release writes the version (package.json and its lock) and the release notes (CHANGELOG.md),
//   builds and verifies the artifact, then commits `chore(release): <tag> [skip ci]` and tags it, as semantic-release
//   does, so the next run (or CI, once turned back on) starts from there. Nothing is pushed or published.
//
// Claudestrator and its JetBrains plugin moved to their own repo (github.com/yurii-bondar/claudestrator), with their
// tags and a release script of their own.
//
// Usage (from the repo root): node scripts/release.mjs [build|test] [--only <target>] [--dry-run] [--force]
//   build      build and verify what is due (the default)
//   test       typecheck, lint and every test of each extension due first, then build
//   --only     one target: scriptor, personify, claude-ctx-man or go-to-project
//   --dry-run  build and verify, then put the version files back: no commit, no tag
//   --force    build a target with nothing due at its last released version (no commit, no tag)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { generateNotes } from '@semantic-release/release-notes-generator';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
/** The rules of release.config.base.cjs: the same preset for the version and for the notes. */
const PRESET = { preset: 'conventionalcommits' };
const SILENT = { log() {}, error() {}, warn() {}, success() {} };

/** A VS Code extension in its own folder: versioned in package.json, packaged by vsce into `<folder>/vsix/`. */
const extension = (dir, label, ships = []) => ({
  label,
  dir,
  tagPrefix: `${dir}-v`,
  paths: [dir],
  versionFiles: [`${dir}/package.json`, `${dir}/package-lock.json`],
  changelog: `${dir}/CHANGELOG.md`,
  /** Files the .vsix must hold besides its main script, icon and readme. */
  ships,
});

const TARGETS = {
  scriptor: extension('scriptor', 'Scriptor', ['extension/dist/media/app.js']),
  personify: extension('personify', 'Personify', ['extension/dist/media/main.js']),
  'claude-ctx-man': extension('claude-ctx-man', 'Claude Ctx Man', ['extension/dist/statusline/render.js']),
  'go-to-project': extension('go-to-project', 'Go to Project'),
};

// ---------- command line ----------

function parseArgs(argv) {
  const opts = { mode: 'build', only: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['build', 'test'].includes(a)) opts.mode = a;
    else if (a === '--only') opts.only = argv[++i];
    else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown argument ${a} (see --help)`);
  }
  if (opts.only && !TARGETS[opts.only]) throw new Error(`--only takes ${Object.keys(TARGETS).join(' or ')}, not ${opts.only}`);
  return opts;
}

// ---------- processes ----------

/** Runs a command and returns its stdout; throws with its stderr when it fails. */
function out(cmd, args, { cwd = ROOT, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input !== undefined && { input }) });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
const git = (...args) => out('git', args).trim();

/** Runs a step with its output on the terminal; throws when it fails. */
function step(title, cmd, args, { cwd = ROOT, env = {} } = {}) {
  // A long argument (the release notes for the plugin) is shown by its start and length.
  const shown = [cmd, ...args].map((a) => (a.length > 120 ? `${a.slice(0, 40)}…(${a.length} characters)` : a));
  console.log(`\n▶ ${title}\n  $ ${shown.join(' ')}  (in ${path.relative(ROOT, cwd) || '.'})`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, shell: WIN });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${title} failed (exit ${r.status})`);
  console.log(`✔ ${title} (${Math.round((Date.now() - started) / 1000)}s)`);
}

const npm = WIN ? 'npm.cmd' : 'npm';

// ---------- versions ----------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parseVersion = (v) => SEMVER.exec(v)?.slice(1).map(Number) ?? null;
const compareVersions = (a, b) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
function increment(version, type) {
  const [major, minor, patch] = parseVersion(version);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** What a target's folders hold at a commit: their git tree hashes, which change with any file in them. */
const contentAt = (commit, paths) => paths.map((p) => spawnSync('git', ['rev-parse', `${commit}:${p}`], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || '-').join(' ');

/** The target's last release: its newest tag by version. Null: it has none yet. */
function lastRelease(target) {
  const tags = git('tag', '--list', `${target.tagPrefix}*`)
    .split('\n')
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.slice(target.tagPrefix.length) }))
    .filter((t) => parseVersion(t.version))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!tags.length) return null;
  const { tag, version } = tags[0];
  return { tag, version, commit: git('rev-list', '-n', '1', tag) };
}

/**
 * The commit since which this branch holds what is not released yet: the release's own commit when it is in this
 * branch's history, else the newest commit here whose folders hold exactly what the release did (the release came
 * in by a squash merge or a rebase). Null: this branch never had the released content.
 */
function releasedHere(release, paths) {
  if (spawnSync('git', ['merge-base', '--is-ancestor', release.commit, 'HEAD'], { cwd: ROOT }).status === 0) return release.commit;
  const released = contentAt(release.commit, paths);
  for (const commit of git('log', '--format=%H', 'HEAD', '--', ...paths).split('\n').filter(Boolean)) {
    if (contentAt(commit, paths) === released) return commit;
  }
  return null;
}

/** The commits after `since` that touch the folders, as semantic-release reads them: `{ hash, message }`. */
function commitsSince(since, paths) {
  return out('git', ['log', '--format=%H%x1f%B%x1e', `${since}..HEAD`, '--', ...paths])
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, message] = r.split('\x1f');
      return { hash, message: message.trim() };
    });
}

/** How many commits of each type: `12 fix, 2 feat, 30 other`. */
function tally(commits) {
  const counts = {};
  for (const { message } of commits) {
    const type = (/^(\w+)(?:\([^)]*\))?(!?):/.exec(message) || [])[1] || 'other';
    counts[type] = (counts[type] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ');
}

/** What is due for a target: a release with its next version, nothing, or a forced rebuild of the last one. */
async function plan(name, opts) {
  const target = { name, ...TARGETS[name] };
  const release = lastRelease(target);
  if (!release) return { target, due: false, why: `no release tag ${target.tagPrefix}<version> yet: tag the commit its published version was built from once, git tag -a ${target.tagPrefix}1.2.3 <commit> -m ${target.tagPrefix}1.2.3` };
  const head = git('rev-parse', 'HEAD');
  const unchanged = contentAt('HEAD', target.paths) === contentAt(release.commit, target.paths);
  const base = { target, release, head };
  if (unchanged) return { ...base, due: false, why: `its folders hold exactly what ${release.tag} did` };
  const since = releasedHere(release, target.paths);
  if (!since) {
    throw new Error(`${target.label}: ${release.tag} (${release.commit.slice(0, 7)}) is not in this branch's history, and no commit here holds what it released. Build on the branch it was released from, or delete the tag if that release never shipped.`);
  }
  const commits = commitsSince(since, target.paths);
  const type = await analyzeCommits(PRESET, { commits, logger: SILENT, cwd: ROOT });
  if (!type) return { ...base, due: false, why: `no commit since ${release.tag} calls for a release (${tally(commits) || 'none'})`, commits };
  const version = increment(release.version, type);
  const tag = `${target.tagPrefix}${version}`;
  if (git('tag', '--list', tag)) throw new Error(`${target.label}: ${tag} exists already, though ${release.tag} is the newest release`);
  // Where the notes link commits and compare views: package.json's repository first, as semantic-release reads it.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, target.dir, 'package.json'), 'utf8'));
  const repositoryUrl = (manifest.repository && (manifest.repository.url || manifest.repository)) || git('remote', 'get-url', 'origin');
  const notes = await generateNotes(PRESET, {
    commits,
    lastRelease: { gitTag: release.tag, gitHead: release.commit, version: release.version },
    nextRelease: { gitTag: tag, gitHead: head, version, type },
    options: { repositoryUrl },
    cwd: ROOT,
    logger: SILENT,
  });
  return { ...base, due: true, type, version, tag, notes, commits, why: `${type}: ${tally(commits)}` };
}

// ---------- writing the version ----------

/** The files a release writes, as they were, to put back after a dry run or a failure. */
function snapshot(target) {
  return [...target.versionFiles, target.changelog].map((rel) => {
    const file = path.join(ROOT, rel);
    return { file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  });
}
function restore(saved) {
  for (const { file, text } of saved) {
    if (text === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text);
  }
}

function writeVersion(target, version) {
  // package.json and package-lock.json together, as semantic-release-vsce does (npm version, no git).
  out(npm, ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: path.join(ROOT, target.dir) });
}

/** The notes on top of CHANGELOG.md, as @semantic-release/changelog writes them. */
function writeChangelog(target, notes) {
  const file = path.join(ROOT, target.changelog);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  fs.writeFileSync(file, `${notes.trim()}\n${before ? `\n${before}\n` : ''}`);
}

// ---------- building and verifying ----------

/** Names in a zip (a .vsix, a plugin .zip). */
const zipEntries = (file) => out('unzip', ['-Z1', file]).split('\n').filter(Boolean);
const zipFile = (file, entry) => out('unzip', ['-p', file, entry]);

function buildExtension(target, version) {
  const dir = path.join(ROOT, target.dir);
  const vsix = path.join(dir, 'vsix', `${target.dir}-${version}.vsix`);
  fs.mkdirSync(path.dirname(vsix), { recursive: true });
  // vsce runs vscode:prepublish (a clean build) and checks the manifest.
  step(`Package ${target.label}`, path.join(ROOT, 'node_modules', '.bin', WIN ? 'vsce.cmd' : 'vsce'), ['package', '--out', vsix], { cwd: dir });
  return vsix;
}

function verifyExtension(target, vsix, version) {
  const entries = zipEntries(vsix);
  const manifest = JSON.parse(zipFile(vsix, 'extension/package.json'));
  const problems = [];
  if (manifest.version !== version) problems.push(`its package.json says ${manifest.version}, not ${version}`);
  const inPackage = (file) => `extension/${path.posix.normalize(file)}`;
  const needed = [inPackage(manifest.main), ...(manifest.icon ? [inPackage(manifest.icon)] : []), 'extension/readme.md', ...target.ships];
  // The Marketplace shows the changelog of a release; a rebuild before the first one (--force) has none yet.
  if (fs.existsSync(path.join(ROOT, target.changelog))) needed.push('extension/changelog.md');
  for (const need of needed) {
    if (!entries.some((e) => e.toLowerCase() === need.toLowerCase())) problems.push(`${need} is missing`);
  }
  const stray = entries.filter((e) => /^extension\/(src|test|dist\/test)\//.test(e) || (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) || /(^|\/)(\.env|\.orch\/|\.claudestrator\/)/.test(e));
  if (stray.length) problems.push(`it ships what it should not: ${stray.slice(0, 5).join(', ')}${stray.length > 5 ? '…' : ''}`);
  const size = fs.statSync(vsix).size;
  if (size > 20 * 1024 * 1024) problems.push(`it is ${(size / 1024 / 1024).toFixed(1)} MB`);
  if (problems.length) throw new Error(`${path.relative(ROOT, vsix)}: ${problems.join('; ')}`);
  console.log(`✔ Verified ${path.relative(ROOT, vsix)}: version ${version}, ${entries.length} files, ${(size / 1024 / 1024).toFixed(2)} MB`);
}

// ---------- tests ----------

/**
 * Runs the tests with a temp folder of their own, removed afterwards with what Claude Code kept of the live run's
 * sessions (`<config>/projects/<the workspace path, as it names it>`): no test leaves anything behind.
 */
function withOwnTemp(fn) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-release-')));
  const env = { TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  try {
    return fn(env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const prefix = tmp.replace(/[^a-zA-Z0-9]/g, '-');
    for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      if (dir.startsWith(prefix)) fs.rmSync(path.join(projects, dir), { recursive: true, force: true });
    }
  }
}

function runTests(due) {
  withOwnTemp((env) => {
    for (const dir of due.map((d) => d.target.dir)) {
      const cwd = path.join(ROOT, dir);
      step(`Typecheck ${dir}`, npm, ['run', 'typecheck'], { cwd, env });
      step(`Lint ${dir}`, npm, ['run', 'lint'], { cwd, env });
      step(`Test ${dir}`, npm, ['test'], { cwd, env });
    }
  });
}

// ---------- the run ----------

function preflight(targets, opts) {
  for (const dir of targets.map((t) => path.join(ROOT, TARGETS[t].dir))) {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) throw new Error(`${path.relative(ROOT, dir)} has no node_modules: run npm ci there first`);
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '@semantic-release'))) throw new Error('the release tooling is not installed: run npm ci in the repo root');
  const paths = [...new Set(targets.flatMap((t) => TARGETS[t].paths))];
  const dirty = git('status', '--porcelain', '--', ...paths);
  if (dirty && !opts.dryRun) throw new Error(`uncommitted changes in ${paths.join(', ')}: a release builds what is committed. Commit or stash them, or use --dry-run.\n${dirty}`);
  if (dirty) console.log(`! uncommitted changes in ${paths.join(', ')}: the dry run builds them, though the versions are worked out from the commits`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') console.log(`! on ${branch}: semantic-release releases from main. This builds what ${branch} holds; after a squash merge, main holds the same content, and the next run starts from it.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const names = opts.only ? [opts.only] : Object.keys(TARGETS);
  preflight(names, opts);

  const plans = [];
  for (const name of names) plans.push(await plan(name, opts));
  console.log('\nRelease plan:');
  for (const p of plans) {
    console.log(p.due ? `  ${p.target.label}: ${p.release.tag} → ${p.tag}  (${p.why})` : `  ${p.target.label}: nothing to release, ${p.why}${opts.force && p.release ? `; rebuilt at ${p.release.version} (--force)` : ''}`);
  }
  const due = plans.filter((p) => p.due);
  const builds = opts.force ? plans.filter((p) => p.release) : due;
  if (!builds.length) {
    console.log('\nNothing to build.');
    return;
  }

  if (opts.mode !== 'build') runTests(builds);

  const saved = builds.map((p) => snapshot(p.target));
  const artifacts = [];
  try {
    for (const p of builds) {
      const version = p.due ? p.version : p.release.version;
      writeVersion(p.target, version);
      if (p.due) writeChangelog(p.target, p.notes);
      const vsix = buildExtension(p.target, version);
      verifyExtension(p.target, vsix, version);
      artifacts.push(vsix);
      p.vsix = vsix;
    }
  } catch (e) {
    saved.forEach(restore);
    throw e;
  }

  // Recorded as semantic-release records a release: the version files and notes in one commit, tagged.
  const recorded = [];
  for (const [i, p] of builds.entries()) {
    if (opts.dryRun || !p.due) {
      restore(saved[i]);
      continue;
    }
    const files = [...p.target.versionFiles, p.target.changelog];
    git('add', '--', ...files);
    out('git', ['commit', '--quiet', '-F', '-', '--', ...files], { input: `chore(release): ${p.tag} [skip ci]\n\n${p.notes.trim()}\n` });
    git('tag', '-a', p.tag, '-m', p.tag);
    recorded.push(p.tag);
  }

  console.log('\nBuilt:');
  for (const a of artifacts) console.log(`  ${path.relative(ROOT, a)}`);
  if (opts.dryRun) console.log('\nDry run: the version files are as they were; nothing was committed or tagged.');
  if (recorded.length) {
    console.log(`\nRecorded ${recorded.join(', ')} (a chore(release) commit and a tag each). Next:`);
    console.log(`  git push --follow-tags        # the release commits and their tags`);
    for (const vsix of builds.filter((p) => recorded.includes(p.tag) && p.vsix).map((p) => p.vsix)) console.log(`  npx @vscode/vsce publish --packagePath ${path.relative(ROOT, vsix)}`);
  }
}

main().catch((e) => {
  console.error(`\n✖ ${e.message}`);
  process.exitCode = 1;
});
