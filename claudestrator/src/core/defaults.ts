// What Claude Code will actually use when an agent leaves model or effort to the default: the CLI is asked
// over its control protocol (`initialize`, `get_settings`) without sending anything to a model, so it costs nothing.
import { spawn, type ChildProcess } from 'child_process';
import type { Agent, Effort } from './types';
import type { Defaults, Effective, ModelInfo, Resolved } from './wire';

const BASE = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];

/** A model the CLI offers, as `initialize` lists it. */
interface CliModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportedEffortLevels?: string[];
}
/** What the CLI answers to `initialize` (`i`) and `get_settings` (`s`). */
interface CliInit {
  models?: CliModel[];
  account?: unknown;
}
interface CliSettings {
  applied?: { model?: string; effort?: string | null };
}
interface Handshake {
  applied: { model?: string; effort?: string | null };
  models: CliModel[];
  account: unknown;
}

/** One handshake: `{ applied: { model, effort }, models, account }`, or null when the CLI does not answer. */
function handshake(command: string, args: string[], { cwd, env, timeoutMs = 20000 }: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; timeoutMs?: number }): Promise<Handshake | null> {
  return new Promise((resolve) => {
    let done = false;
    const got: { i?: CliInit; s?: CliSettings } = {};
    let proc: ChildProcess;
    const finish = (value: Handshake | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        // already gone
      }
      resolve(value);
    };
    try {
      proc = spawn(command, [...BASE, ...args], { ...(cwd !== undefined && { cwd }), ...(env !== undefined && { env }), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => finish(null), timeoutMs);
    proc.on('error', () => finish(null));
    proc.on('exit', () => finish(got.s ? { applied: got.s.applied || {}, models: (got.i && got.i.models) || [], account: got.i && got.i.account } : null));
    proc.stdin!.on('error', () => {});
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { type?: string; response?: { subtype?: string; request_id: 'i' | 's'; response?: CliInit & CliSettings } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== 'control_response' || !m.response) continue;
        if (m.response.subtype === 'success') (got as Record<string, CliInit & CliSettings>)[m.response.request_id] = m.response.response || {};
        if (got.s && got.i) finish({ applied: got.s.applied || {}, models: got.i.models || [], account: got.i.account });
      }
    });
    proc.stdin!.write(`${JSON.stringify({ type: 'control_request', request_id: 'i', request: { subtype: 'initialize' } })}\n`);
    proc.stdin!.write(`${JSON.stringify({ type: 'control_request', request_id: 's', request: { subtype: 'get_settings' } })}\n`);
  });
}

/**
 * The model and effort each model choice resolves to under this account and these settings.
 * `aliases`: the model values agents use (`inherit`, `opus`, `claude-sonnet-5-5`, …).
 * Returns `{ byModel: { <alias>: { model, effort } }, models: [{ value, model, name, efforts }], account, at }` or null.
 */
async function resolveDefaults({ command, cwd, env, settingSources, aliases = [] }: { command: string; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; settingSources?: string[] | null | undefined; aliases?: (string | undefined)[] }): Promise<Defaults | null> {
  const sources = settingSources && settingSources.length ? ['--setting-sources', settingSources.join(',')] : [];
  const wanted = [...new Set(aliases.filter((a): a is string => Boolean(a && a !== 'inherit')))];
  const [base, ...rest] = await Promise.all([
    handshake(command, sources, { cwd, env }),
    ...wanted.map((alias) => handshake(command, [...sources, '--model', alias], { cwd, env })),
  ]);
  if (!base) return null;
  const pick = (r: Handshake | null | undefined): Resolved | null => (r ? { model: r.applied.model, effort: r.applied.effort ?? null } : null);
  const byModel: Record<string, Resolved | null> = { inherit: pick(base) };
  wanted.forEach((alias, i) => {
    if (rest[i]) byModel[alias] = pick(rest[i]);
  });
  const models = base.models
    .filter((m) => m.value !== 'default')
    .map((m) => ({ value: m.value, model: m.resolvedModel || m.value, name: m.displayName, efforts: m.supportedEffortLevels || [] }));
  return { byModel, models, account: base.account, at: Date.now() };
}

/** `claude-opus-5-5` → `Opus 5.5` from the CLI's model list, else a readable guess. */
function modelName(id: string | null | undefined, models: { model: string; value: string; name: string }[] = []): string {
  if (!id) return '';
  const hit = models.find((m) => m.model === id || m.value === id);
  if (hit) return hit.name;
  const x = String(id).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (x) return `${x[1]![0]!.toUpperCase()}${x[1]!.slice(1)} ${x[2]}${x[3] && x[3].length <= 2 ? `.${x[3]}` : ''}`;
  return /^[a-z]+$/.test(id) ? `${id[0]!.toUpperCase()}${id.slice(1)}` : id;
}

/** What an agent runs with: `{ model, modelName, effort, effortIsDefault, modelIsDefault }`; null parts when unknown. */
function effectiveFor(agent: Pick<Agent, 'model' | 'effort'>, defaults: Defaults | null | undefined, taskEffort?: Effort | string | null): Effective {
  const d = defaults && (defaults.byModel[agent.model && agent.model !== 'inherit' ? agent.model : 'inherit'] || null);
  const model = (d && d.model) || (agent.model !== 'inherit' ? agent.model : null);
  const effort = taskEffort || agent.effort || (d ? d.effort : null);
  return {
    model,
    modelName: modelName(model, (defaults && defaults.models) as ModelInfo[] | undefined),
    modelIsDefault: !agent.model || agent.model === 'inherit',
    effort,
    effortIsDefault: !taskEffort && !agent.effort,
    defaultEffort: d ? d.effort : null,
  };
}

export type { CliModel, Defaults, Effective, ModelInfo, Resolved };
export { handshake, resolveDefaults, modelName, effectiveFor };
