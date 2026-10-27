// Gates: a repo's lint/typecheck/test commands, run against its changes after a code or tests stage.
const fs = require('fs');
const path = require('path');
const { exec, GitRepo } = require('./git');

const TAIL_LINES = 40;
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

function shellCommand(cmd) {
  if (process.platform === 'win32') return ['cmd.exe', ['/d', '/s', '/c', cmd]];
  return [fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', ['-c', cmd]];
}

/**
 * Runs a repo's gates. A repo without changes is skipped, and so is a gate whose `when` prefix matches
 * no changed file (unless `force`). Logs go to `logDir`. `onGate(name)` reports progress.
 */
async function runGates({ repo, dir, logDir, timeoutMs = 15 * 60000, force = false, onGate }) {
  const git = new GitRepo(dir);
  if (!(await git.isRepo())) {
    return { repo: repo.name, status: 'fail', results: [{ repo: repo.name, gate: '(repo)', status: 'fail' }], summary: `FAIL ${repo.name}: not a git repo at ${dir}` };
  }
  if (repo.gates.length === 0) return { repo: repo.name, status: 'skipped', results: [], summary: `SKIP ${repo.name}: no gates configured` };

  const changed = await git.changedFiles(repo.baseBranch);
  if (changed.length === 0 && !force) return { repo: repo.name, status: 'skipped', results: [], summary: `SKIP ${repo.name}: no changes` };

  fs.mkdirSync(logDir, { recursive: true });
  const results = [];
  const lines = [];
  for (const gate of repo.gates) {
    if (!force && gate.when && !changed.some((f) => f.startsWith(gate.when))) {
      results.push({ repo: repo.name, gate: gate.name, status: 'skipped' });
      lines.push(`SKIP ${repo.name} ${gate.name}: nothing under ${gate.when}`);
      continue;
    }
    if (onGate) onGate(gate.name);
    const cwd = path.join(dir, gate.dir ?? '.');
    const started = Date.now();
    const [bin, args] = shellCommand(gate.cmd);
    const r = await exec(bin, args, { cwd, timeoutMs });
    const ms = Date.now() - started;
    const log = path.join(logDir, `${slug(repo.name)}.${slug(gate.name)}.log`);
    const output = `${r.stdout}${r.stderr}`;
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

module.exports = { runGates, shellCommand };
