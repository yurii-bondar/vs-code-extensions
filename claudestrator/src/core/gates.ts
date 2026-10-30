// Gates: a repo's lint/typecheck/test commands, run against its changes after a code or tests stage.
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getChildEnv, GitRepo } from './git';
import type { RepoConfig } from './types';
import type { GateResult, RepoGates } from './wire';

const TAIL_LINES = 40;
/** Output kept per gate: the end of it, which is where a failure shows. */
const KEEP_CHARS = 4 * 1024 * 1024;
/** How long a gate gets after SIGTERM before its process group is killed. */
const KILL_GRACE_MS = 3000;
// Gate commands print plain text: colour codes are noise in the tail an agent reads, and some tools only colour on a terminal anyway.
const PLAIN_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' };
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Output as an agent should read it: no colour codes, and a progress line redrawn with \r keeps only its last state. */
function plain(output: string): string {
  return output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
    .join('\n');
}

function shellCommand(cmd: string): [string, string[]] {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', cmd]];
  return [fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-c', cmd]];
}

interface ShellRun {
  code: number;
  output: string;
  /** Why it was killed: it ran out of time, or the task was stopped. */
  killed?: 'timeout' | 'stopped';
}

/**
 * Runs a gate command in a process group of its own, so a timeout or a stopped task ends everything it started
 * (test workers, a dev server), not only the shell. stdout and stderr are kept in one text, in the order they arrive.
 */
function runShell(cmd: string, { cwd, env, timeoutMs, signal }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal | undefined }): Promise<ShellRun> {
  return new Promise((resolve) => {
    const [bin, args] = shellCommand(cmd);
    const win = process.platform === 'win32';
    let output = '';
    let killed: ShellRun['killed'];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd, env, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return resolve({ code: 127, output: (e as Error).message });
    }
    const keep = (d: string): void => {
      output += d;
      if (output.length > 2 * KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };
    child.stdout!.setEncoding('utf8').on('data', keep);
    child.stderr!.setEncoding('utf8').on('data', keep);
    const killTree = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (win) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        else process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    let grace: NodeJS.Timeout | undefined;
    const kill = (why: NonNullable<ShellRun['killed']>): void => {
      if (killed) return;
      killed = why;
      killTree('SIGTERM');
      grace = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = (): void => kill('stopped');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => keep(`${(e as NodeJS.ErrnoException).code === 'ENOENT' ? `${bin}: not found` : e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      // The shell is gone; anything it left in its group goes too.
      if (!win && killed) killTree('SIGKILL');
      const note = killed === 'timeout' ? `\nkilled after ${Math.round(timeoutMs / 1000)}s` : killed === 'stopped' ? '\nstopped with the task' : '';
      resolve({ code: killed === 'timeout' ? 124 : killed === 'stopped' ? 130 : code ?? 1, output: output + note, ...(killed && { killed }) });
    });
  });
}

/**
 * Runs a repo's gates. A repo without changes is skipped, and so is a gate whose `when` prefix matches
 * no changed file (unless `force`). Logs go to `logDir`. `onGate(name)` reports progress. `signal` stops the gate
 * that runs and skips the rest.
 */
async function runGates({ repo, dir, logDir, timeoutMs = 15 * 60000, force = false, onGate, signal }: { repo: RepoConfig; dir: string; logDir: string; timeoutMs?: number; force?: boolean | undefined; onGate?: ((name: string) => void) | undefined; signal?: AbortSignal | undefined }): Promise<RepoGates> {
  const git = new GitRepo(dir);
  if (!(await git.isRepo())) {
    return { repo: repo.name, status: 'fail', results: [{ repo: repo.name, gate: '(repo)', status: 'fail' }], summary: `FAIL ${repo.name}: not a git repo at ${dir}` };
  }
  if (repo.gates.length === 0) return { repo: repo.name, status: 'skipped', results: [], summary: `SKIP ${repo.name}: no gates configured` };

  const changed = await git.changedFiles(repo.baseBranch);
  if (changed.length === 0 && !force) return { repo: repo.name, status: 'skipped', results: [], summary: `SKIP ${repo.name}: no changes` };

  fs.mkdirSync(logDir, { recursive: true });
  const results: GateResult[] = [];
  const lines: string[] = [];
  for (const gate of repo.gates) {
    if (signal && signal.aborted) {
      results.push({ repo: repo.name, gate: gate.name, status: 'skipped' });
      lines.push(`SKIP ${repo.name} ${gate.name}: the task was stopped`);
      continue;
    }
    if (!force && gate.when && !changed.some((f) => f.startsWith(gate.when!))) {
      results.push({ repo: repo.name, gate: gate.name, status: 'skipped' });
      lines.push(`SKIP ${repo.name} ${gate.name}: nothing under ${gate.when}`);
      continue;
    }
    if (onGate) onGate(gate.name);
    const cwd = path.join(dir, gate.dir ?? '.');
    const started = Date.now();
    const r = await runShell(gate.cmd, { cwd, timeoutMs, env: { ...getChildEnv(), ...PLAIN_ENV }, signal });
    const ms = Date.now() - started;
    const log = path.join(logDir, `${slug(repo.name)}.${slug(gate.name)}.log`);
    const output = plain(r.output);
    fs.writeFileSync(log, `$ (cd ${path.relative(dir, cwd) || '.'} && ${gate.cmd})\n${output}\nexit ${r.code}\n`);
    if (r.code === 0) {
      results.push({ repo: repo.name, gate: gate.name, status: 'pass', log, ms });
      lines.push(`PASS ${repo.name} ${gate.name}`);
    } else {
      results.push({ repo: repo.name, gate: gate.name, status: 'fail', log, ms, tail: output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n') });
      const tail = output.trimEnd().split('\n').slice(-TAIL_LINES).map((l) => `    ${l}`).join('\n');
      lines.push(`FAIL ${repo.name} ${gate.name} (exit ${r.code}; cd ${repo.name}/${gate.dir ?? '.'} && ${gate.cmd}) log: ${log}\n${tail}`);
    }
  }
  const status = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'pass') ? 'pass' : 'skipped';
  return { repo: repo.name, status, results, summary: lines.join('\n') };
}

export type { GateResult, RepoGates };
export { plain, runGates, runShell, shellCommand };
