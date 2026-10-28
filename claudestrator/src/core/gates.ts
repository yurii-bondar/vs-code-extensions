// Gates: a repo's lint/typecheck/test commands, run against its changes after a code or tests stage.
import * as fs from 'fs';
import * as path from 'path';
import { exec, getChildEnv, GitRepo } from './git';
import type { RepoConfig } from './types';
import type { GateResult, RepoGates } from './wire';

const TAIL_LINES = 40;
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

/**
 * Runs a repo's gates. A repo without changes is skipped, and so is a gate whose `when` prefix matches
 * no changed file (unless `force`). Logs go to `logDir`. `onGate(name)` reports progress.
 */
async function runGates({ repo, dir, logDir, timeoutMs = 15 * 60000, force = false, onGate }: { repo: RepoConfig; dir: string; logDir: string; timeoutMs?: number; force?: boolean | undefined; onGate?: ((name: string) => void) | undefined }): Promise<RepoGates> {
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
    if (!force && gate.when && !changed.some((f) => f.startsWith(gate.when!))) {
      results.push({ repo: repo.name, gate: gate.name, status: 'skipped' });
      lines.push(`SKIP ${repo.name} ${gate.name}: nothing under ${gate.when}`);
      continue;
    }
    if (onGate) onGate(gate.name);
    const cwd = path.join(dir, gate.dir ?? '.');
    const started = Date.now();
    const [bin, args] = shellCommand(gate.cmd);
    const r = await exec(bin, args, { cwd, timeoutMs, env: { ...getChildEnv(), ...PLAIN_ENV } });
    const ms = Date.now() - started;
    const log = path.join(logDir, `${slug(repo.name)}.${slug(gate.name)}.log`);
    const output = plain(`${r.stdout}${r.stderr}`);
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
export { plain, runGates, shellCommand };
