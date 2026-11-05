import { execFile } from 'child_process';
import type { RepoRoot } from './types';

/** Environment for one git call, on top of the extension host's: an account's header, for one. */
export interface RunOptions {
  env?: Readonly<Record<string, string>>;
}

/** Runs one git command in a repository and gives back its stdout. */
export interface GitRunner {
  run(cwd: RepoRoot, args: readonly string[], options?: RunOptions): Promise<string>;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  /** What git printed before it failed: some commands (`merge-tree`) put their answer there and exit 1. */
  readonly stdout: string;

  constructor({ args, stderr, stdout, exitCode }: { args: readonly string[]; stderr: string; stdout: string; exitCode: number | null }) {
    super(stderr.trim() || `git ${args.join(' ')} failed`);
    this.args = args;
    this.exitCode = exitCode;
    this.stdout = stdout;
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
    run: (cwd, args, options) =>
      new Promise((resolve, reject) => {
        execFile(gitPath, [...args], { cwd, env: options?.env ? { ...env, ...options.env } : env, maxBuffer: MAX_OUTPUT }, (err, stdout, stderr) => {
          if (err) reject(new GitError({ args, stderr, stdout, exitCode: typeof err.code === 'number' ? err.code : null }));
          else resolve(stdout);
        });
      }),
  };
}
