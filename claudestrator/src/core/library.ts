// Libraries: agents and scenarios kept in a folder of their own (library.yaml, with the instruction files in prompts/),
// listed under `libraries:` in the user config (for all of your projects) or in a project's config (for the team).
// config.ts loads them as layers; this module lists, adds and removes them, and moves a project's own agents and
// scenarios into one.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { CONFIG_DIR, LIBRARY_FILE, PROMPTS_DIR, editProjectConfig, editYamlFile, libraryFile, libraryLabel, projectConfigFile, readProjectLayer, userConfigFile, withConfigRollback, writeIn } from './config';
import { exists, writeAtomic } from './files';
import { validateConfigLayer, validateLibraryLayer } from './protocol';
import type { AgentLayer, ConfigLayer } from './config';
import type { LibraryView as LibraryInfo } from './wire';

type Scope = LibraryInfo['scope'];

interface Where {
  workspace: string;
  home?: string | undefined;
}

const homeOf = (home: string | undefined): string => home ?? os.homedir();

function configOf(scope: Scope, { workspace, home }: Where): string {
  return scope === 'user' ? userConfigFile(homeOf(home)) : projectConfigFile(workspace);
}

/** A YAML file's data; {} when it is not there. Throws when it does not parse. */
async function readYaml(file: string): Promise<unknown> {
  const text = await fs.promises.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return '';
    throw e;
  });
  return YAML.parse(text) ?? {};
}

/** The `libraries:` entries a config lists; none when it does not exist or does not parse (loadConfig reports that). */
async function entriesOf(file: string): Promise<string[]> {
  try {
    const raw = (await readYaml(file)) as ConfigLayer;
    return Array.isArray(raw.libraries) ? raw.libraries.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** Every library the user config and the project config list, in the order they load, with what each holds. */
async function listLibraries(where: Where): Promise<LibraryInfo[]> {
  const out: LibraryInfo[] = [];
  for (const scope of ['user', 'project'] as const) {
    const config = configOf(scope, where);
    for (const entry of await entriesOf(config)) {
      const file = libraryFile(entry, path.dirname(config), homeOf(where.home));
      if (out.some((l) => l.file === file)) continue;
      const info: LibraryInfo = { file, label: libraryLabel(file), scope, entry, exists: await exists(file), agents: [], scenarios: [] };
      if (info.exists) {
        try {
          const raw = (await readYaml(file)) as ConfigLayer;
          info.agents = Object.keys(raw.agents ?? {});
          info.scenarios = Object.keys(raw.scenarios ?? {});
        } catch (e) {
          info.error = (e as Error).message;
        }
      }
      out.push(info);
    }
  }
  return out;
}

/**
 * How a config should name a library folder: relative to the project's .claudestrator/ when the library lives inside
 * the workspace (so it works in every clone), `~/…` when it is under the home folder, else absolute.
 */
function entryFor(dir: string, scope: Scope, where: Where): string {
  const abs = path.resolve(dir);
  const home = homeOf(where.home);
  const inside = (root: string): boolean => abs === root || abs.startsWith(root + path.sep);
  if (scope === 'project' && inside(path.resolve(where.workspace))) {
    const rel = path.relative(path.join(where.workspace, CONFIG_DIR), abs).split(path.sep).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  }
  if (inside(home)) return `~/${path.relative(home, abs).split(path.sep).join('/')}`;
  return abs;
}

const LIBRARY_TEMPLATE = `# Claudestrator library: agents and scenarios, written as in .claudestrator/config.yaml.
# Instruction files go in ${PROMPTS_DIR}/ next to this file. A project uses the library when its config, or
# ~/.claudestrator/config.yaml, lists this folder under \`libraries:\`.
agents: {}
scenarios: {}
`;

/**
 * Lists a library folder in the user or the project config. Without a library.yaml in it, `create` writes an empty
 * one; otherwise that is an error. Undone if the config no longer resolves with it (a broken library.yaml).
 */
async function addLibrary({ dir, scope, create = false, ...where }: Where & { dir: string; scope: Scope; create?: boolean }): Promise<LibraryInfo> {
  const file = libraryFile(dir, process.cwd(), homeOf(where.home));
  if ((await listLibraries(where)).some((l) => l.file === file)) throw new Error(`${libraryLabel(file)} is already one of this project's libraries`);
  if (!(await exists(file)) && !create) throw new Error(`There is no ${LIBRARY_FILE} in ${path.dirname(file)}`);
  const config = configOf(scope, where);
  const entry = entryFor(path.dirname(file), scope, where);
  await withConfigRollback(where, async (remember) => {
    await remember(config);
    if (!(await exists(file))) {
      await remember(file);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, LIBRARY_TEMPLATE);
    }
    const entries = await entriesOf(config);
    await editYamlFile(config, (doc) => writeIn(doc, ['libraries'], [...entries, entry]), { validate: validateConfigLayer, what: config });
  });
  return (await listLibraries(where)).find((l) => l.file === file)!;
}

/** Stops listing a library. Undone, with the reason, when the project needs it (a scenario names its agents). */
async function removeLibrary({ file, scope, ...where }: Where & { file: string; scope: Scope }): Promise<void> {
  const config = configOf(scope, where);
  const rest = (await entriesOf(config)).filter((e) => libraryFile(e, path.dirname(config), homeOf(where.home)) !== file);
  await withConfigRollback(where, async (remember) => {
    await remember(config);
    await editYamlFile(config, (doc) => writeIn(doc, ['libraries'], rest.length ? rest : undefined), { validate: validateConfigLayer, what: config });
  });
}

const defined = <T extends object>(obj: T): Partial<T> => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Moves what this project's config defines (agents, custom scenarios) into one of its libraries. A scenario brings the
 * agents of this project's own that it runs; an agent brings its instructions file (prompts/<file> in the library, and
 * the project's copy is removed). The same names in the library are replaced. Undone if the config no longer resolves.
 */
async function moveToLibrary({ library, agents = [], scenarios = [], ...where }: Where & { library: string; agents?: string[]; scenarios?: string[] }): Promise<{ agents: string[]; scenarios: string[] }> {
  const target = (await listLibraries(where)).find((l) => l.file === library);
  if (!target) throw new Error('That is not one of this project\'s libraries');
  if (!target.exists) throw new Error(`Library ${target.label} is not at ${target.file}`);
  const project = await readProjectLayer(where.workspace);
  const own = project.agents ?? {};
  const names = new Set(agents);
  for (const id of scenarios) {
    const entry = project.scenarios?.[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`"${id}" is not a scenario of this project's own`);
    for (const step of entry.agents) {
      const name = typeof step === 'string' ? step : step.agent;
      if (own[name]) names.add(name);
    }
  }
  for (const name of names) if (!own[name]) throw new Error(`"${name}" is not defined in this project's config`);

  const projectDir = path.join(where.workspace, CONFIG_DIR);
  const libraryDir = path.dirname(target.file);
  return withConfigRollback(where, async (remember) => {
    await remember(target.file);
    const moved: Record<string, AgentLayer> = {};
    const leftBehind: string[] = [];
    for (const name of names) {
      let def: AgentLayer = { ...own[name]! };
      const ins = def.instructions;
      if (ins && typeof ins === 'object' && ins.file !== undefined) {
        const source = path.resolve(projectDir, ins.file);
        const content = await fs.promises.readFile(source, 'utf8').catch(() => null);
        if (content !== null) {
          const rel = `${PROMPTS_DIR}/${path.basename(source)}`;
          const dest = path.join(libraryDir, rel);
          const there = await fs.promises.readFile(dest, 'utf8').catch(() => null);
          if (there !== null && path.resolve(dest) !== source && there !== content) throw new Error(`Library ${target.label} already has a different ${rel}`);
          await remember(dest);
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await writeAtomic(dest, content);
          def = { ...def, instructions: { ...ins, file: `./${rel}` } };
          // The project's copy goes, unless it lives outside its prompts/ (a file the user keeps elsewhere).
          if (source.startsWith(path.join(projectDir, PROMPTS_DIR) + path.sep) && path.resolve(dest) !== source) leftBehind.push(source);
        }
      }
      moved[name] = def;
    }
    await editYamlFile(
      target.file,
      (doc) => {
        // `agents: {}` (as a new library has it) would keep everything added to it on one line.
        for (const key of ['agents', 'scenarios']) {
          const node = doc.get(key, true);
          if (YAML.isMap(node)) node.flow = false;
        }
        // Into what the library has there already, so its comments stay.
        for (const [name, def] of Object.entries(moved)) writeIn(doc, ['agents', name], defined(def));
        for (const id of scenarios) writeIn(doc, ['scenarios', id], project.scenarios![id]);
      },
      { validate: validateLibraryLayer, what: `library ${target.label}` }
    );
    await editProjectConfig(where.workspace, (doc) => {
      for (const name of names) doc.deleteIn(['agents', name]);
      for (const id of scenarios) doc.deleteIn(['scenarios', id]);
      const left = doc.getIn(['scenarios']) as YAML.YAMLMap | undefined;
      if (left && YAML.isMap(left) && left.items.length === 0) doc.deleteIn(['scenarios']);
    });
    for (const file of leftBehind) {
      await remember(file);
      await fs.promises.rm(file, { force: true });
    }
    return { agents: [...names], scenarios };
  });
}

export type { LibraryInfo, Scope };
export { listLibraries, addLibrary, removeLibrary, moveToLibrary };
