import { execFile } from 'child_process';
import type { RepoRoot } from './types';

/** Runs one git command in a repository and gives back its stdout. */
export interface GitRunner {
  run(cwd: RepoRoot, args: readonly string[]): Promise<string>;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;

  constructor({ args, stderr, exitCode }: { args: readonly string[]; stderr: string; exitCode: number | null }) {
    super(stderr.trim() || `git ${args.join(' ')} failed`);
    this.args = args;
    this.exitCode = exitCode;
  }
}

const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs the git binary at `gitPath` (the one VS Code's Git extension found). Output is collected whole, so this
 * is for commands with bounded output; a long `git log` wants `spawn` and a stream.
 */
export function createGitRunner(gitPath: string): GitRunner {
  // LC_ALL=C: git translates some of what we parse (`%(upstream:track)` prints "ahead 1" in English only under C).
  // GIT_TERMINAL_PROMPT=0: a command that needs credentials fails instead of waiting for input nobody can give.
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  return {
    run: (cwd, args) =>
      new Promise((resolve, reject) => {
        execFile(gitPath, [...args], { cwd, env, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
          if (err) reject(new GitError({ args, stderr, exitCode: typeof err.code === 'number' ? err.code : null }));
          else resolve(stdout);
        });
      }),
  };
}
