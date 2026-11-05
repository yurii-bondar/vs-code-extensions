// Real repositories for the tests, in a temp dir, kept away from the user's git config: signing, hooks or another
// default branch would change what git does.
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGitRunner } from '../src/core/git';
import type { GitRunner } from '../src/core/git';
import type { RepoRoot } from '../src/core/types';

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

export const git: GitRunner = createGitRunner('git');

export interface TestRepo {
  /** The temp dir holding everything; remove it when done. */
  dir: string;
  /** A clone of `remote`, with `main` pushed. */
  work: RepoRoot;
  remote: string;
  run(...args: string[]): Promise<string>;
  /** Writes files (path → content) and commits them. */
  commit(message: string, files?: Record<string, string>): Promise<void>;
}

export async function makeRepo(): Promise<TestRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'githor-')));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work') as RepoRoot;
  await git.run(dir as RepoRoot, ['init', '--bare', '-b', 'main', remote]);
  await git.run(dir as RepoRoot, ['clone', remote, work]);
  const run = (...args: string[]): Promise<string> => git.run(work, args);
  const commit = async (message: string, files: Record<string, string> = {}): Promise<void> => {
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(work, file)), { recursive: true });
      await fs.writeFile(path.join(work, file), content);
      await run('add', file);
    }
    await run('commit', '--allow-empty', '-m', message);
  };
  await commit('first', { 'README.md': 'hello\n' });
  await run('push', '-u', 'origin', 'main');
  return { dir, work, remote, run, commit };
}
