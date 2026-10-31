// Evals of the agents' instructions against the Claude Code CLI installed here (`npm run eval`; not part of `npm test`,
// it costs money). Each case is a small workspace with a known answer, run through the real engine: a reviewer must
// block a planted bug and let a clean change through, a planner must name only the repo a ticket is about, an auditor
// must find a planted vulnerability. A change to an agent's instructions, model or effort is run against them before it
// ships. The agents run with their configured models; EVAL_MODEL and EVAL_EFFORT (haiku, low) make a cheap run, and
// EVAL_CASES (reviewer-blocks,planner-scope) picks cases.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { Engine } from '../../src/core/engine';
import { ClaudeRunner, parseFlags } from '../../src/core/runner';
import { HookServer } from '../../src/core/hookserver';
import { setChildEnv } from '../../src/core/git';
import type { Audit, TaskState } from '../../src/core/types';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Files of a repo: committed as its base, then changed in the working tree (what the reviewer reads as the diff). */
interface RepoFixture {
  role: string;
  base: Record<string, string>;
  change?: Record<string, string>;
}

interface Case {
  name: string;
  /** What is typed into the composer. */
  task: string;
  pipeline: string[];
  repos: Record<string, RepoFixture>;
  /** Why the result is wrong, or null when it is right. */
  judge(s: TaskState): string | null;
}

const PRICE_BASE = {
  'src/price.js': `// Prices are in cents.\nfunction total(items) {\n  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);\n}\nmodule.exports = { total };\n`,
  'package.json': `${JSON.stringify({ name: 'shop', version: '1.0.0', private: true }, null, 2)}\n`,
};

/** The reviewer's verdict of a task, and whether it has a blocking finding about `file`. */
function verdictOf(s: TaskState): { status: string; blocking: string[] } {
  const v = s.review.verdicts[0] || s.review.lastVerdicts[0];
  if (!v) return { status: 'none', blocking: [] };
  return { status: v.status, blocking: v.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major').map((f) => `${f.file ?? ''} ${f.problem}`) };
}

const CASES: Case[] = [
  {
    name: 'reviewer-blocks',
    task: 'Add discount(cents, percent) to src/price.js: the price after a percentage discount, in whole cents. --auto',
    pipeline: ['planner', 'reviewer'],
    repos: {
      shop: {
        role: 'Shop backend (Node)',
        base: PRICE_BASE,
        // Planted: the percentage is applied the wrong way round, and a discount over 100% gives a negative price.
        change: { 'src/price.js': `// Prices are in cents.\nfunction total(items) {\n  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);\n}\nfunction discount(cents, percent) {\n  return Math.round(cents * percent / 100);\n}\nmodule.exports = { total, discount };\n` },
      },
    },
    judge: (s) => {
      const v = verdictOf(s);
      if (v.status !== 'changes_requested') return `the verdict is ${v.status}, not changes_requested: discount() returns the discount, not the price`;
      return v.blocking.some((b) => b.includes('price.js')) ? null : `no blocking finding names src/price.js (${v.blocking.join('; ') || 'none'})`;
    },
  },
  {
    name: 'reviewer-passes',
    task: 'Add discount(cents, percent) to src/price.js: the price after a percentage discount, in whole cents. --auto',
    pipeline: ['planner', 'reviewer'],
    repos: {
      shop: {
        role: 'Shop backend (Node)',
        base: PRICE_BASE,
        change: {
          'src/price.js': `// Prices are in cents.\nfunction total(items) {\n  return items.reduce((sum, i) => sum + i.cents * i.qty, 0);\n}\n/** The price after a discount of \`percent\` (0–100), rounded to whole cents. */\nfunction discount(cents, percent) {\n  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a whole number of cents, 0 or more');\n  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) throw new RangeError('percent must be a number between 0 and 100');\n  return Math.round((cents * (100 - percent)) / 100);\n}\nmodule.exports = { total, discount };\n`,
          'test/price.test.js': `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { discount } = require('../src/price');\n\ntest('discount', () => {\n  assert.equal(discount(1000, 25), 750);\n  assert.equal(discount(999, 50), 500);\n  assert.equal(discount(1000, 0), 1000);\n  assert.equal(discount(1000, 100), 0);\n  assert.throws(() => discount(1000, 101), RangeError);\n  assert.throws(() => discount(1000, -1), RangeError);\n  assert.throws(() => discount(1000, '50'), RangeError);\n  assert.throws(() => discount(1000, NaN), RangeError);\n  assert.throws(() => discount(-1, 10), RangeError);\n  assert.throws(() => discount(10.5, 10), RangeError);\n});\n`,
        },
      },
    },
    judge: (s) => {
      const v = verdictOf(s);
      return v.status === 'approved' ? null : `a correct, tested change got ${v.status} (${v.blocking.join('; ') || 'no blocking finding'})`;
    },
  },
  {
    name: 'planner-scope',
    task: 'Fix: GET /orders/:id returns 500 when the order has no items; it should return the order with an empty items list. --auto',
    pipeline: ['planner'],
    repos: {
      api: {
        role: 'Orders REST API (Node): routes in src/routes',
        base: { 'src/routes/orders.js': `const db = require('../db');\nasync function getOrder(req, res) {\n  const order = await db.order(req.params.id);\n  res.json({ ...order, total: order.items.reduce((s, i) => s + i.cents, 0) });\n}\nmodule.exports = { getOrder };\n`, 'src/db.js': 'module.exports = { order: async () => ({ id: 1, items: null }) };\n' },
      },
      web: {
        role: 'Storefront (React): pages in src/pages',
        base: { 'src/pages/Order.jsx': 'export function Order({ order }) {\n  return <ul>{order.items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>;\n}\n' },
      },
    },
    judge: (s) => {
      if (!s.plan) return 'no plan';
      const names = s.plan.repos.map((r) => r.name);
      if (!names.includes('api')) return `the plan leaves out api (${names.join(', ')})`;
      if (s.plan.type !== 'fix') return `a bug fix planned as ${s.plan.type}`;
      return null;
    },
  },
  {
    name: 'auditor-finds',
    task: 'Audit the project: bugs, security, bottlenecks',
    pipeline: [],
    repos: {
      api: {
        role: 'Admin REST API (Node, Express)',
        base: {
          'src/admin.js': `const { execSync } = require('child_process');\n// Restarts a service by name, for the admin page.\nfunction restart(req, res) {\n  const out = execSync('systemctl restart ' + req.query.service);\n  res.send(out.toString());\n}\nmodule.exports = { restart };\n`,
          'src/util.js': 'function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\nmodule.exports = { clamp };\n',
        },
      },
    },
    judge: (s) => {
      const audit = s.reports[0] && (s.reports[0].value as Audit);
      if (!audit) return 'no audit report';
      const hit = audit.findings.find((f) => (f.file ?? '').includes('admin.js') && (f.severity === 'critical' || f.severity === 'high'));
      return hit ? null : `the command injection in src/admin.js is not a critical or high finding (${audit.findings.map((f) => `${f.severity} ${f.file ?? ''}`).join('; ') || 'no findings'})`;
    },
  },
];

function workspace(c: Case): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cs-eval-${c.name}-`)));
  for (const [name, repo] of Object.entries(c.repos)) {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const write = (files: Record<string, string>): void => {
      for (const [file, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
    };
    write(repo.base);
    git(dir, 'add', '.');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    if (repo.change) write(repo.change);
  }
  const model = process.env.EVAL_MODEL;
  const effort = process.env.EVAL_EFFORT;
  const tune = model || effort ? `{ ${[model && `model: ${model}`, effort && `effort: ${effort}`].filter(Boolean).join(', ')} }` : null;
  fs.mkdirSync(path.join(ws, '.claudestrator'));
  fs.writeFileSync(
    path.join(ws, '.claudestrator', 'config.yaml'),
    [
      'repos:',
      ...Object.entries(c.repos).map(([name, r]) => `  ${name}: { role: ${JSON.stringify(r.role)} }`),
      ...(c.pipeline.length ? [`pipeline: [${c.pipeline.join(', ')}]`] : []),
      ...(tune ? ['agents:', ...['planner', 'reviewer', 'auditor'].map((a) => `  ${a}: ${tune}`)] : []),
      'limits: { budgetUsd: 5 }',
      '',
    ].join('\n')
  );
  return ws;
}

async function main(): Promise<void> {
  const claude = process.env.CLAUDE_PATH || 'claude';
  const version = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
  const flags = parseFlags(execFileSync(claude, ['--help'], { encoding: 'utf8' }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com' };
  delete env.CLAUDECODE;
  setChildEnv(env);
  const only = (process.env.EVAL_CASES || '').split(',').filter(Boolean);
  const cases = CASES.filter((c) => !only.length || only.includes(c.name));
  console.log(`Claude Code ${version}; ${cases.length} cases${process.env.EVAL_MODEL ? ` on ${process.env.EVAL_MODEL}` : ' on the configured models'}`);

  const hooks = new HookServer();
  await hooks.listen();
  const results: { name: string; problem: string | null; usd: number }[] = [];
  try {
    for (const c of cases) {
      const ws = workspace(c);
      const runner = new ClaudeRunner({ command: () => claude, version: () => version, flags: () => flags, settingSources: () => ['project', 'local'], env: () => ({}) });
      const engine = new Engine({ workspace: ws, runner, hooks });
      let problem: string | null;
      let usd = 0;
      try {
        const { taskId } = await engine.start({ text: c.task });
        const s = await engine.run(taskId);
        const err = engine.lastError(taskId);
        usd = await engine.spentUsd(taskId);
        problem = err ? `${err.code}: ${err.message}` : !s ? 'the task did not run' : s.checkpoint ? `stopped at ${s.checkpoint.id}: ${s.checkpoint.reason ?? ''}` : c.judge(s);
      } catch (e) {
        problem = (e as Error).message;
      }
      results.push({ name: c.name, problem, usd });
      console.log(`${problem ? '✖' : '✔'} ${c.name} ($${usd.toFixed(3)})${problem ? `: ${problem}` : ''}${problem ? `\n    workspace: ${ws}` : ''}`);
      if (!problem) fs.rmSync(ws, { recursive: true, force: true });
    }
  } finally {
    hooks.dispose();
  }
  const passed = results.filter((r) => !r.problem).length;
  console.log(`${passed}/${results.length} passed, $${results.reduce((n, r) => n + r.usd, 0).toFixed(2)}`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e);
  process.exitCode = 1;
});
