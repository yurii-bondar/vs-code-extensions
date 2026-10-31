// First-run help: finds the git repositories of a workspace and suggests gates from what each repo uses.
import * as fs from 'fs';
import * as path from 'path';
import { exists } from './files';
import type { FoundRepo, RepoGuess, SuggestedGate } from './wire';
import type { RepoLayer } from './config';
import type { Gate } from './types';

const SKIP = new Set(['node_modules', '.git', '.orch', '.claudestrator', 'dist', 'build', 'out', 'vendor', 'target', '.venv', 'venv', '.next', '.nuxt', 'coverage']);

/** A package.json as far as the gate guess reads it. */
interface PackageJson {
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const isGitRoot = (dir: string): Promise<boolean> => exists(path.join(dir, '.git'));
const read = (file: string): Promise<string> => fs.promises.readFile(file, 'utf8').catch(() => '');
const readJson = async (file: string): Promise<PackageJson | null> => {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};
/** Whether any of these files is in `dir`. */
const hasAny = async (dir: string, ...names: string[]): Promise<boolean> => (await Promise.all(names.map((n) => exists(path.join(dir, n))))).includes(true);

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';

/** Git repos at the workspace root and up to two levels below it. */
async function findRepos(workspace: string): Promise<FoundRepo[]> {
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (await isGitRoot(dir)) {
      found.push(dir);
      if (dir !== workspace) return; // nested repos inside a repo are its own business
    }
    if (depth >= 2) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      await visit(path.join(dir, e.name), depth + 1);
    }
  };
  await visit(workspace, 0);
  // A root repo that also contains repos (a "workspace" repo) is rarely where the work happens.
  const names = new Set<string>();
  return Promise.all(
    found.map(async (dir) => {
      let name = safeName(dir === workspace ? path.basename(workspace) : path.relative(workspace, dir).split(path.sep).pop()!);
      while (names.has(name)) name = `${name}-2`;
      names.add(name);
      const rel = path.relative(workspace, dir) || '.';
      return { name, path: rel.split(path.sep).join('/'), dir, ...(await describeRepo(dir)) };
    })
  );
}

async function packageManager(dir: string): Promise<string> {
  if (await hasAny(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (await hasAny(dir, 'yarn.lock')) return 'yarn';
  if (await hasAny(dir, 'bun.lockb', 'bun.lock')) return 'bun';
  return 'npm';
}

/** Suggested gates and a guessed role for one repo. */
async function describeRepo(dir: string): Promise<RepoGuess> {
  const gates: SuggestedGate[] = [];
  const stack: string[] = [];
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const pm = await packageManager(dir);
    const runScript = (s: string): string => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    stack.push(deps.nuxt ? 'Nuxt' : deps.next ? 'Next.js' : deps.react ? 'React' : deps.vue ? 'Vue' : deps['@nestjs/core'] ? 'NestJS' : deps.express ? 'Express' : 'Node.js');
    if (deps.typescript) stack.push('TypeScript');
    const pick = (...names: string[]): string | undefined => names.find((n) => scripts[n]);
    const lint = pick('lint');
    const types = pick('typecheck', 'type-check', 'types', 'tsc', 'check-types');
    const test = pick('test:unit', 'unit', 'test');
    if (lint) gates.push({ name: 'lint', cmd: runScript(lint) });
    if (types) gates.push({ name: 'typecheck', cmd: runScript(types) });
    if (test && !/no test specified/.test(scripts[test]!)) gates.push({ name: 'test', cmd: test === 'test' && pm === 'npm' ? 'npm test' : runScript(test) });
  }
  if (await hasAny(dir, 'go.mod')) {
    stack.push('Go');
    gates.push({ name: 'vet', cmd: 'go vet ./...' }, { name: 'test', cmd: 'go test ./...' });
    if (await hasAny(dir, '.golangci.yml', '.golangci.yaml')) gates.unshift({ name: 'lint', cmd: 'golangci-lint run' });
  }
  if (await hasAny(dir, 'Cargo.toml')) {
    stack.push('Rust');
    gates.push({ name: 'check', cmd: 'cargo check --all-targets --quiet' }, { name: 'test', cmd: 'cargo test --quiet' });
  }
  const pyproject = await read(path.join(dir, 'pyproject.toml'));
  if (pyproject || (await hasAny(dir, 'requirements.txt'))) {
    stack.push('Python');
    if (/ruff/.test(pyproject)) gates.push({ name: 'lint', cmd: 'ruff check .' });
    if (/mypy/.test(pyproject)) gates.push({ name: 'typecheck', cmd: 'mypy .' });
    if (/pytest/.test(pyproject) || (await hasAny(dir, 'pytest.ini', 'tests'))) gates.push({ name: 'test', cmd: 'pytest -q' });
  }
  if (!gates.length) {
    const make = await read(path.join(dir, 'Makefile'));
    for (const target of ['lint', 'test']) if (new RegExp(`^${target}:`, 'm').test(make)) gates.push({ name: target, cmd: `make ${target}` });
  }
  const seen = new Set<string>();
  return {
    gates: gates.filter((g) => !seen.has(g.name) && seen.add(g.name)),
    stack: [...new Set(stack)],
    role: (pkg && pkg.description) || undefined,
    baseBranch: await guessBase(dir),
  };
}

/** origin's HEAD branch if git recorded it, else main/master by what exists. */
async function guessBase(dir: string): Promise<string | undefined> {
  const head = (await read(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'HEAD'))).trim();
  const m = head.match(/refs\/remotes\/origin\/(.+)$/);
  if (m) return m[1];
  const packed = await read(path.join(dir, '.git', 'packed-refs'));
  for (const b of ['main', 'master', 'develop']) {
    if (packed.includes(`refs/heads/${b}`) || (await exists(path.join(dir, '.git', 'refs', 'heads', b)))) return b;
  }
  return undefined;
}

const WORKSPACE_MAP = (repos: { name: string; path: string; role?: string | undefined; stack?: string[] | undefined }[]): string => `# Workspace map

Every Claudestrator agent reads this first. Keep it short and accurate: it is the cheapest way to get better plans.

## Repositories

${repos.map((r) => `- **${r.name}** (\`${r.path}\`): ${r.role || 'what it is, who uses it'}${r.stack && r.stack.length ? ` · ${r.stack.join(', ')}` : ''}`).join('\n')}

## Contracts between them

- Which repo produces which API / event / schema, and who consumes it.

## Merge order

- Which repo must be merged and deployed first when a change crosses repos.
`;

/**
 * Repos from folders picked anywhere on disk, for a workspace at `root`: a picked git repo as is, else the repos
 * found inside it. Paths inside the workspace become relative, the rest stay absolute.
 * Returns `{ repos, notRepos }`; `taken` holds names and folders already configured.
 */
async function reposFromFolders(root: string, folders: string[], taken: { names: string[]; dirs: string[] } = { names: [], dirs: [] }): Promise<{ repos: (FoundRepo & { outside: boolean })[]; notRepos: string[] }> {
  const names = new Set(taken.names);
  const dirs = new Set(taken.dirs.map((d) => path.resolve(d)));
  const repos: (FoundRepo & { outside: boolean })[] = [];
  const notRepos: string[] = [];
  for (const folder of folders) {
    const found = (await isGitRoot(folder)) ? [folder] : (await findRepos(folder)).map((r) => r.dir);
    if (!found.length) notRepos.push(folder);
    for (const dir of found) {
      if (dirs.has(path.resolve(dir))) continue;
      dirs.add(path.resolve(dir));
      let name = safeName(path.basename(dir));
      for (let n = 2; names.has(name); n++) name = `${safeName(path.basename(dir))}-${n}`;
      names.add(name);
      const rel = path.relative(root, dir);
      const outside = rel.startsWith('..') || path.isAbsolute(rel);
      repos.push({ name, path: outside ? dir : (rel || '.').split(path.sep).join('/'), dir, outside, ...(await describeRepo(dir)) });
    }
  }
  return { repos, notRepos };
}

/**
 * What config.yaml says about a repo picked in the setup wizard or from the detected list: only what differs from the
 * defaults (path = its name, the workspace's base branch, no gates).
 */
function repoLayerOf(repo: { name: string; path: string; role?: string | undefined; baseBranch?: string | undefined; gates?: Gate[] | undefined }, workspaceBase = 'main'): RepoLayer {
  return {
    ...(repo.role && { role: repo.role }),
    ...(repo.path !== repo.name && { path: repo.path }),
    ...(repo.baseBranch && repo.baseBranch !== workspaceBase && { baseBranch: repo.baseBranch }),
    ...(repo.gates && repo.gates.length && { gates: repo.gates }),
  };
}

export type { FoundRepo, RepoGuess, SuggestedGate };
export { findRepos, describeRepo, reposFromFolders, repoLayerOf, WORKSPACE_MAP, safeName };
