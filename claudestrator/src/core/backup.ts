// A backup of what a project's .claudestrator/config.yaml says about its agents, its pipeline and its scenarios, as a
// file of its own.
//
// It is YAML, like the config it comes from: the sections are copied as they stand, so the file reads the same way,
// diffs in git and can be pasted back by hand. The yaml parser reads JSON too, so a backup converted to JSON restores.
// An agent's instructions often live in a file under .claudestrator/ (prompts/<agent>.md); those files travel inside the
// backup (`files:`), so it can be restored into another project.
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { CONFIG_DIR, PROMPTS_DIR, loadConfig, projectConfigFile, readProjectLayer, removeScenario, setAgentLayer, setCustomScenario, setPipeline, setScenario, withConfigRollback } from './config';
import { validateConfigLayer } from './protocol';
import type { AgentLayer, ConfigLayer } from './config';
import type { ScenarioStep } from './types';

/** The key that marks a file as a backup; its value is the format version. */
const MARKER = 'claudestrator-backup';
const FORMAT = 1;

type Scenarios = NonNullable<ConfigLayer['scenarios']>;
type ScenarioEntry = Scenarios[string];

interface Backup {
  savedAt: string | undefined;
  agents: Record<string, AgentLayer>;
  /** The instruction files of those agents, by path inside .claudestrator/ (`./prompts/security-reviewer.md`). */
  files: Record<string, string>;
  pipeline: string[] | undefined;
  scenarios: Scenarios;
}

type ParsedBackup = { ok: true; backup: Backup } | { ok: false; error: string };

interface Skipped {
  kind: 'agent' | 'pipeline' | 'scenario';
  id: string;
  reason: string;
}

interface Added {
  add: string[];
  replace: string[];
}

/** What restoring a backup into a workspace would do. Whatever it names that the project cannot run is in `skipped`. */
interface RestorePlan {
  agents: Added;
  pipeline: boolean;
  scenarios: Added;
  skipped: Skipped[];
}

interface BackupFile {
  text: string;
  agents: number;
  scenarios: number;
  pipeline: boolean;
}

const configDirOf = (workspace: string): string => path.join(workspace, CONFIG_DIR);

/** The absolute path of `target` inside `dir`; null when it points outside (or at `dir` itself). `p` is for tests of Windows paths. */
function inside(dir: string, target: string, p: path.PlatformPath = path): string | null {
  const abs = p.resolve(dir, target);
  const rel = p.relative(dir, abs);
  return rel && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel) ? abs : null;
}

/**
 * A file as the backup names it, the same on every OS: a path under .claudestrator/prompts/ with `/`
 * (`prompts/a.md`), a `\` read as `/`. Null for anything else: an absolute path (`/etc/x`, `C:\x`), one that climbs
 * out (`../x`), or another file of .claudestrator/ (`config.yaml`), which a backup must never overwrite. Checked as
 * text, so a backup made on Windows restores on macOS and the other way round.
 */
function fileKey(rel: string): string | null {
  const posix = rel.replace(/\\/g, '/');
  if (path.posix.isAbsolute(posix) || /^[a-zA-Z]:/.test(posix)) return null;
  const norm = path.posix.normalize(posix);
  return norm.startsWith(`${PROMPTS_DIR}/`) ? norm : null;
}

/** Reads the project's agents, pipeline and scenarios, with the instruction files of its agents, into the text of a backup. */
function createBackup({ workspace, now }: { workspace: string; now: Date }): BackupFile {
  // readProjectLayer reads a broken file as empty; a backup must say the file is broken, not that it holds nothing.
  const configFile = projectConfigFile(workspace);
  if (fs.existsSync(configFile)) {
    try {
      YAML.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new Error(`config.yaml does not parse, so it cannot be backed up: ${(e as Error).message}`);
    }
  }
  const layer = readProjectLayer(workspace);
  const dir = configDirOf(workspace);
  const agents: Record<string, AgentLayer> = {};
  const files: Record<string, string> = {};
  for (const [name, def] of Object.entries(layer.agents ?? {})) {
    const own = def.instructions;
    agents[name] = def;
    if (!own || typeof own !== 'object' || own.file === undefined) continue;
    const abs = path.resolve(dir, own.file);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // a file that is already missing stays as it is; a restore reports it
    }
    const rel = inside(path.join(dir, PROMPTS_DIR), abs) && `./${path.relative(dir, abs).split(path.sep).join('/')}`;
    // Only prompts/ is restored as files; text kept anywhere else goes into the agent itself.
    agents[name] = { ...def, instructions: rel ? { ...own, file: rel } : { ...(own.mode && { mode: own.mode }), text: content } };
    if (rel) files[rel] = content;
  }
  const scenarios = layer.scenarios ?? {};
  const pipeline = layer.pipeline && layer.pipeline.length ? layer.pipeline : undefined;
  const counts = { agents: Object.keys(agents).length, scenarios: Object.keys(scenarios).length, pipeline: pipeline !== undefined };
  if (!counts.agents && !counts.scenarios && !counts.pipeline) throw new Error('There is nothing to back up yet: agents, the pipeline and scenarios are saved in config.yaml once you change one');

  const doc = new YAML.Document({
    [MARKER]: FORMAT,
    savedAt: now.toISOString(),
    ...(counts.agents && { agents }),
    ...(pipeline && { pipeline }),
    ...(counts.scenarios && { scenarios }),
    ...(Object.keys(files).length && { files }),
  });
  doc.commentBefore = ' Claudestrator backup: agents, pipeline and scenarios.\n Restore it from the menu: "Restore from backup".';
  // A list of plain names reads best on one line, as the extension writes it in config.yaml: `pipeline: [ planner, developer ]`.
  YAML.visit(doc, {
    Seq(_key, node) {
      if (node.items.every((item) => YAML.isScalar(item))) node.flow = true;
    },
  });
  return { text: doc.toString({ lineWidth: 0 }), ...counts };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    return { ok: false, error: `The file is not valid YAML or JSON: ${(e as Error).message}` };
  }
  if (!isRecord(data)) return { ok: false, error: 'This is not a Claudestrator backup' };
  const version = data[MARKER];
  if (version === undefined) return { ok: false, error: `This is not a Claudestrator backup (it has no "${MARKER}" line)` };
  if (typeof version !== 'number' || version > FORMAT) return { ok: false, error: 'This backup was made by a newer Claudestrator; update it to restore the file' };

  const agents = data.agents ?? {};
  const scenarios = data.scenarios ?? {};
  const files = data.files ?? {};
  const pipeline = data.pipeline;
  if (!isRecord(files) || !Object.values(files).every((v) => typeof v === 'string')) return { ok: false, error: 'The backup\'s "files" section must map a path to the text of that file' };
  const outside = Object.keys(files).find((rel) => fileKey(rel) === null);
  if (outside !== undefined) return { ok: false, error: `The backup names a file outside .claudestrator/${PROMPTS_DIR}/ ("${outside}"), so it is not restored` };
  // The shape is the one config.yaml accepts, so that check is the same one.
  const issues = validateConfigLayer({ agents, scenarios, ...(pipeline !== undefined && { pipeline }) });
  if (issues.length) return { ok: false, error: `The backup is not valid: ${issues.join('; ')}` };
  const backup: Backup = {
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : undefined,
    agents: agents as Record<string, AgentLayer>,
    files: files as Record<string, string>,
    pipeline: Array.isArray(pipeline) && pipeline.length ? (pipeline as string[]) : undefined,
    scenarios: scenarios as Scenarios,
  };
  if (!Object.keys(backup.agents).length && !Object.keys(backup.scenarios).length && !backup.pipeline) return { ok: false, error: 'The backup is empty: it holds no agents, pipeline or scenarios' };
  return { ok: true, backup };
}

/** The agents a scenario runs. A built-in report scenario is a bare list (or `false`); a custom one has steps. */
function agentsOf(entry: ScenarioEntry): string[] {
  if (entry === false) return [];
  const steps = Array.isArray(entry) ? entry : entry.agents;
  return steps.map((step) => (typeof step === 'string' ? step : step.agent));
}

const listed = (names: string[]): string => names.map((n) => `"${n}"`).join(', ');

function planRestore({ backup, known, existing }: { backup: Backup; known: ReadonlySet<string>; existing: ConfigLayer }): RestorePlan {
  const plan: RestorePlan = { agents: { add: [], replace: [] }, pipeline: false, scenarios: { add: [], replace: [] }, skipped: [] };
  const kept = new Set(Object.keys(backup.agents));
  const filesHere = new Set(Object.keys(backup.files).map(fileKey));

  // An agent comes back only when what it builds on does: its base agent, and its instruction file.
  const trouble = (def: AgentLayer): string | undefined => {
    if (def.extends && !known.has(def.extends) && !kept.has(def.extends)) return `builds on the agent "${def.extends}", which this project does not have`;
    const own = def.instructions;
    if (own && typeof own === 'object' && own.file !== undefined) {
      const key = fileKey(own.file);
      if (key === null) return `keeps its instructions in a file outside .claudestrator/${PROMPTS_DIR}/`;
      if (!filesHere.has(key)) return 'keeps its instructions in a file that is not in the backup';
    }
    return undefined;
  };
  for (let again = true; again; ) {
    again = false;
    for (const name of [...kept]) {
      const why = trouble(backup.agents[name]!);
      if (!why) continue;
      kept.delete(name);
      plan.skipped.push({ kind: 'agent', id: name, reason: why });
      again = true; // an agent that builds on this one may now be missing its base
    }
  }
  for (const name of Object.keys(backup.agents)) if (kept.has(name)) (existing.agents && name in existing.agents ? plan.agents.replace : plan.agents.add).push(name);

  const runnable = new Set([...known, ...kept]);
  if (backup.pipeline) {
    const missing = backup.pipeline.filter((n) => !runnable.has(n));
    if (missing.length) plan.skipped.push({ kind: 'pipeline', id: 'pipeline', reason: `names ${listed(missing)}, which this project does not have` });
    else plan.pipeline = true;
  }
  for (const [id, entry] of Object.entries(backup.scenarios)) {
    const missing = agentsOf(entry).filter((n) => !runnable.has(n));
    if (missing.length) plan.skipped.push({ kind: 'scenario', id, reason: `needs the agent${missing.length === 1 ? '' : 's'} ${listed(missing)}, which this project does not have` });
    else (existing.scenarios && id in existing.scenarios ? plan.scenarios.replace : plan.scenarios.add).push(id);
  }
  return plan;
}

/** The agents this workspace has now (built-in ones included); throws while its config does not load. */
function currentAgents({ workspace, home }: { workspace: string; home?: string | undefined }): Set<string> {
  const r = loadConfig({ workspace, home });
  if (!r.ok) throw new Error(`Fix the config first: ${r.errors.map((e) => e.message).join('; ')}`);
  return new Set(Object.keys(r.config.agents));
}

/** What a restore would change, for the question asked before it runs. */
function previewRestore({ workspace, backup, home }: { workspace: string; backup: Backup; home?: string | undefined }): RestorePlan {
  return planRestore({ backup, known: currentAgents({ workspace, home }), existing: readProjectLayer(workspace) });
}

/**
 * Writes the backup into the project: an agent or scenario with the same name is replaced (the agent entirely, its
 * instruction file too), the others stay, and the pipeline is replaced when the backup has one. What the project cannot
 * run is left out and reported. If the result would not resolve (code and report agents mixed, say), the config file
 * and the instruction files go back to what they were and the error is thrown: a bad config breaks every task.
 */
function restoreBackup({ workspace, backup, home }: { workspace: string; backup: Backup; home?: string | undefined }): RestorePlan {
  const plan = previewRestore({ workspace, backup, home });
  const dir = configDirOf(workspace);
  withConfigRollback({ workspace, home }, (remember) => {
    for (const name of [...plan.agents.add, ...plan.agents.replace]) {
      let def = backup.agents[name]!;
      const own = def.instructions;
      if (own && typeof own === 'object' && own.file !== undefined) {
        const key = fileKey(own.file)!;
        const abs = inside(dir, key)!;
        const content = Object.entries(backup.files).find(([rel]) => fileKey(rel) === key)![1];
        remember(abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        // The config names the file the way it was written (`./prompts/a.md`), whatever OS made the backup.
        def = { ...def, instructions: { ...own, file: `./${key}` } };
      }
      setAgentLayer(workspace, name, def);
    }
    if (plan.pipeline) setPipeline(workspace, backup.pipeline!);
    for (const id of [...plan.scenarios.add, ...plan.scenarios.replace]) writeScenario(workspace, id, backup.scenarios[id]!);
  });
  return plan;
}

function writeScenario(workspace: string, id: string, entry: ScenarioEntry): void {
  if (entry === false) removeScenario(workspace, id);
  else if (Array.isArray(entry)) setScenario(workspace, id, entry);
  else {
    const agents = entry.agents.map((step): ScenarioStep => (typeof step === 'string' ? { name: step } : { name: step.agent, ...(step.model && { model: step.model }), ...(step.effort && { effort: step.effort }) }));
    setCustomScenario(workspace, id, { label: entry.label || id, description: entry.description, agents });
  }
}

export type { Backup, BackupFile, ParsedBackup, RestorePlan, Skipped };
export { MARKER, createBackup, parseBackup, previewRestore, restoreBackup, inside, fileKey };
