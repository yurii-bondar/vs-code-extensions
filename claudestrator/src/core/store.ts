// Task storage: `<workspace>/.orch/tasks/<id>/events.ndjson` is the source of truth and the state is
// rebuilt from it. Same layout as the claudestrator CLI and plugin, so either can pick a task up.
import * as fs from 'fs';
import * as path from 'path';
import { INFO_EVENTS, STATE_EVENTS } from './protocol';
import { replay, transition, nextAction, TASK_FILES } from './machine';
import { deriveTaskId } from './intake';
import type { TaskEntry } from './view';
import type { NextAction } from './machine';
import type { Config, Effort, EventBody, IntakeSettings, EventOf, OrchEvent, NewEvent, Pipeline, Source, TaskGroup, TaskInstruction, TaskState } from './types';
import type { TranscriptItem } from './wire';

const ORCH_DIR = '.orch';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;


/** Whether the process that wrote a lock file is gone (it crashed holding the lock). */
async function holderGone(file: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await fs.promises.readFile(file, 'utf8')).trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** How often a running task's lease is renewed, and how long one goes unrenewed before it counts as abandoned. */
const LEASE_RENEW_MS = 10000;
const LEASE_STALE_MS = 45000;
const LEASE_FILE = 'run.lease';

/** Whether a process with this pid is there (EPERM: it is, under another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The leases this process holds, by file, with the task service that took each. Two engines live in one extension
 * host when the workspace folder changes while a task runs: the new one must see the old one's run as elsewhere too.
 */
const leasesHere = new Map<string, object>();

/** The pid of another live process (or another engine of this one) holding this lease and renewing it, or null. */
async function otherHolder(file: string, me?: object): Promise<number | null> {
  const here = leasesHere.get(file);
  if (here !== undefined) return here === me ? null : process.pid;
  try {
    const [text, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    return Date.now() - st.mtimeMs < LEASE_STALE_MS && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Cross-process mutex on a lock file (O_EXCL create), held for a read-transition-append. Only the claudestrator CLI or
 * plugin can hold it besides this process; waiting for them is a timer, so the extension host keeps running meanwhile.
 * A lock left by a crashed process is taken over at once, one older than `staleMs` (a holder that hangs) as well.
 * The folder must be there: a task deleted while its run still ends does not come back as a folder with one event.
 */
async function withLock<T>(file: string, fn: () => Promise<T>, { timeoutMs = 10000, staleMs = 10000 }: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.promises.open(file, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${path.dirname(file)} is gone (the task was deleted)`);
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = await fs.promises.stat(file).then(
        (st) => Date.now() - st.mtimeMs,
        () => null
      );
      if (age === null) continue; // released between our open and stat
      if (age > staleMs || (await holderGone(file))) {
        await fs.promises.rm(file, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${file}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}

/**
 * Append-only NDJSON log of one task. A torn last line (a crash mid-write) is ignored on read
 * and cut off by the next append.
 */
class EventStore {
  file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** The events, read without blocking; none when there is no log yet. */
  async read(): Promise<OrchEvent[]> {
    try {
      return this.parse(await fs.promises.readFile(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  /** The log's complete lines as events; a torn last line is left out. */
  parse(text: string): OrchEvent[] {
    const lines = text.split('\n').slice(0, -1);
    return lines
      .filter((line) => line.trim() !== '')
      .map((line, i) => {
        let e: OrchEvent;
        try {
          e = JSON.parse(line);
        } catch {
          throw new Error(`${this.file}:${i + 1}: not valid JSON`);
        }
        if (!e || typeof e.type !== 'string' || typeof e.seq !== 'number') throw new Error(`${this.file}:${i + 1}: not an event`);
        return e;
      });
  }

  /** Appends an event as number `seq` when the caller knows how many there are, else counts them. */
  async append(event: NewEvent, seq?: number): Promise<OrchEvent> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const torn = await this.cutTornTail();
    const stored = { seq: seq !== undefined && !torn ? seq : (await this.read()).length + 1, ...event } as OrchEvent;
    await fs.promises.appendFile(this.file, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  /** Cuts a torn last line off, and says whether there was one. Only its last byte is read when there is none. */
  async cutTornTail(): Promise<boolean> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.file, 'r');
    } catch {
      return false;
    }
    try {
      const { size } = await handle.stat();
      const last = Buffer.alloc(1);
      if (size === 0 || ((await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] === 0x0a)) return false;
    } finally {
      await handle.close();
    }
    const buf = await fs.promises.readFile(this.file);
    await fs.promises.truncate(this.file, buf.lastIndexOf(0x0a) + 1);
    return true;
  }
}

/** What `start` needs to create a task. */
interface StartRequest {
  taskId?: string | undefined;
  input: string;
  source: Source;
  scenario?: string | undefined;
  scenarioName?: string | undefined;
  scenarioLabel?: string | undefined;
  group?: TaskGroup | undefined;
  instructions?: TaskInstruction[] | undefined;
  auto: boolean;
  pipeline: Pick<Pipeline, 'mode' | 'stages' | 'reviewLoop'>;
  config: Pick<Config, 'limits' | 'repos' | 'context' | 'git'>;
  effort?: Record<string, Effort> | undefined;
  model?: Record<string, string> | undefined;
  stepInstructions?: Record<string, string> | undefined;
  intake?: IntakeSettings | undefined;
}

type DispatchResult =
  | { ok: true; event: OrchEvent; state: TaskState; next: NextAction }
  | { ok: false; error: { code: string; message: string }; state: TaskState | null };

class TaskService {
  workspace: string;
  root: string;
  currentFile: string;
  now: () => Date;
  onAppend: ((taskId: string, event: OrchEvent) => void) | undefined;
  /** Each task's state and events, with the signature of the log they were read from. */
  cache: Map<string, { sig: string; state: TaskState; events: OrchEvent[] }>;
  /** The events file's signature right after this process's last append to it, per task. */
  written = new Map<string, string>();
  /** Transcript lines not written yet, per file, and the write in flight per file: one file's lines stay in order. */
  queued = new Map<string, string[]>();
  writes = new Map<string, Promise<void>>();
  /** How many writes each transcript file has had queued: a read that saw the count change reads again. */
  started = new Map<string, number>();

  constructor({ workspace, now, onAppend }: { workspace: string; now?: (() => Date) | undefined; onAppend?: ((taskId: string, event: OrchEvent) => void) | undefined }) {
    this.workspace = workspace;
    this.root = path.join(workspace, ORCH_DIR, 'tasks');
    this.currentFile = path.join(workspace, ORCH_DIR, 'current');
    this.now = now || (() => new Date());
    this.onAppend = onAppend;
    this.cache = new Map();
  }

  /** `.orch/` holds machine state and worktrees; it never belongs in a commit. */
  async ensureOrchDir(): Promise<void> {
    const dir = path.join(this.workspace, ORCH_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }

  /** The task last started here (`.orch/current`), shared with the CLI. */
  async currentTask(): Promise<string | null> {
    const id = (await fs.promises.readFile(this.currentFile, 'utf8').catch(() => '')).trim();
    return id && TASK_ID.test(id) && (await this.exists(id)) ? id : null;
  }

  async setCurrent(taskId: string): Promise<void> {
    await this.ensureOrchDir();
    await fs.promises.writeFile(this.currentFile, `${taskId}\n`);
  }

  async clearCurrent(): Promise<void> {
    await fs.promises.rm(this.currentFile, { force: true });
  }

  dir(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error(`invalid task id "${taskId}"`);
    return path.join(this.root, taskId);
  }

  /** Each task's writes in this process, one after another: a dispatch reads, decides and appends with nothing between. */
  queues = new Map<string, Promise<unknown>>();

  /** Runs `fn` with the task's log to itself: after this process's earlier writes to it, and under its lock file. */
  locked<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const lock = path.join(this.dir(taskId), '.lock');
    const run = (this.queues.get(taskId) ?? Promise.resolve()).then(() => withLock(lock, fn));
    const tail = run.catch(() => undefined);
    this.queues.set(taskId, tail);
    void tail.then(() => {
      if (this.queues.get(taskId) === tail) this.queues.delete(taskId);
    });
    return run;
  }

  /** The task's state as its log is now, read without blocking (and cached as `state` keeps it); null without a log. */
  async current(taskId: string): Promise<TaskState | null> {
    const file = path.join(this.dir(taskId), TASK_FILES.events);
    const sig = await signatureAsync(file);
    if (!sig) return null;
    const hit = this.cache.get(taskId);
    if (hit && hit.sig === sig) return hit.state;
    const events = await this.store(taskId).read();
    const state = replay(events);
    this.cache.set(taskId, { sig, state, events });
    return state;
  }

  store(taskId: string): EventStore {
    return new EventStore(path.join(this.dir(taskId), TASK_FILES.events));
  }

  /**
   * Appends to a task's log. When the cached state was read from the log as it was, it follows the append (`next`, or
   * the same state for an informational event) instead of being replayed from the file on the next read.
   */
  async append(taskId: string, event: NewEvent, next?: TaskState): Promise<OrchEvent> {
    const store = this.store(taskId);
    const hit = this.cache.get(taskId);
    const current = hit && hit.sig === (await signatureAsync(store.file)) ? hit : undefined;
    const stored = await store.append(event, current ? current.events.length + 1 : undefined);
    const sig = await signatureAsync(store.file);
    this.written.set(taskId, sig);
    // A new object for a new log, also when nothing changed: what is derived from a state is cached by it.
    if (current && stored.seq === current.events.length + 1) this.cache.set(taskId, { sig, state: next ?? { ...current.state }, events: [...current.events, stored] });
    else this.cache.delete(taskId);
    if (this.onAppend) this.onAppend(taskId, stored);
    return stored;
  }

  /**
   * Whether the events file is as this process last wrote it. A file watcher then reports a change that `onAppend`
   * has already announced, and refreshing again would only repeat the same work.
   */
  async isOwnWrite(taskId: string): Promise<boolean> {
    const mine = this.written.get(taskId);
    return mine !== undefined && mine === (await signatureAsync(path.join(this.dir(taskId), TASK_FILES.events)));
  }

  async exists(taskId: string): Promise<boolean> {
    return TASK_ID.test(taskId) && (await signatureAsync(path.join(this.dir(taskId), TASK_FILES.events))) !== '';
  }

  /**
   * The id a new task gets, and whether a task with it exists (starting it then continues that task).
   * Same Jira issue or Confluence page → the same task. A description always gets a fresh id.
   * A readiness check or audit that already finished is not continued: checking again is a new run (`CP-1-check-2`).
   */
  async idFor({ taskId: given, source, scenario = 'deliver' }: { taskId?: string | undefined; source: Source; scenario?: string }): Promise<{ taskId: string; exists: boolean }> {
    if (given) return { taskId: given, exists: await this.exists(given) };
    const base = deriveTaskId(source, this.now(), scenario);
    let taskId = base;
    if (source.kind === 'text') {
      for (let n = 2; await this.exists(taskId); n++) taskId = `${base}-${n}`;
      return { taskId, exists: false };
    }
    if (scenario !== 'deliver') for (let n = 2; (await this.exists(taskId)) && (await this.finished(taskId)); n++) taskId = `${base}-${n}`;
    return { taskId, exists: await this.exists(taskId) };
  }

  /** Creates a task, or returns the existing one `idFor` points at. */
  async start(req: StartRequest): Promise<{ taskId: string; created: boolean; state: TaskState }> {
    const scenario = req.scenario || 'deliver';
    const { taskId, exists } = await this.idFor({ taskId: req.taskId, source: req.source, scenario });
    if (exists) return { taskId, created: false, state: await this.state(taskId) };
    this.dir(taskId);
    const event: EventOf<'task_created'> = {
      type: 'task_created',
      taskId,
      input: req.input,
      source: req.source,
      ...(scenario !== 'deliver' && { scenario }),
      ...(req.scenarioName && { scenarioName: req.scenarioName, scenarioLabel: req.scenarioLabel }),
      ...(req.group && { group: req.group }),
      ...(req.instructions && req.instructions.length && { instructions: req.instructions }),
      auto: req.auto,
      pipeline: { mode: req.pipeline.mode, stages: req.pipeline.stages, reviewLoop: req.pipeline.reviewLoop },
      limits: { reviewRounds: req.config.limits.reviewRounds, gateAttempts: req.config.limits.gateAttempts },
      knownRepos: Object.keys(req.config.repos),
      contextFiles: req.config.context ?? [],
      gitMode: (req.config.git && req.config.git.mode) || 'branch',
      ...(req.effort && Object.keys(req.effort).length && { effort: req.effort }),
      ...(req.model && Object.keys(req.model).length && { model: req.model }),
      ...(req.stepInstructions && Object.keys(req.stepInstructions).length && { stepInstructions: req.stepInstructions }),
      ...(req.intake && { intake: req.intake }),
      at: this.now().toISOString(),
    };
    const r = transition(null, event);
    if (!r.ok) throw new Error(r.error.message);
    await this.ensureOrchDir();
    await fs.promises.mkdir(this.dir(taskId), { recursive: true });
    const id = taskId;
    return this.locked(id, async () => {
      const there = await this.current(id);
      if (there) return { taskId: id, created: false, state: there };
      await this.append(id, event);
      return { taskId: id, created: true, state: r.state };
    });
  }

  /** The task's events, read once per change of its log; callers do not change the array. */
  async events(taskId: string): Promise<OrchEvent[]> {
    await this.state(taskId);
    return this.cache.get(taskId)!.events;
  }

  async finished(taskId: string): Promise<boolean> {
    try {
      return (await this.state(taskId)).status === 'done';
    } catch {
      return false;
    }
  }

  /** The task's state: its log replayed, kept until the log changes because the UI asks often. Throws for no task. */
  async state(taskId: string): Promise<TaskState> {
    const state = await this.current(taskId);
    if (!state) throw new Error(`no task "${taskId}"`);
    return state;
  }

  /** The single entry point for changing a task: validate, transition, then persist, or log the rejection. */
  dispatch(taskId: string, body: EventBody): Promise<DispatchResult> {
    return this.locked(taskId, () => this.dispatchUnlocked(taskId, body));
  }

  async dispatchUnlocked(taskId: string, body: EventBody): Promise<DispatchResult> {
    // Under the lock the cached state is current unless another process appended, which its signature shows.
    const state = await this.current(taskId);
    if (!body || typeof body.type !== 'string' || !STATE_EVENTS.has(body.type)) {
      return this.reject(taskId, state, body, { code: 'invalid_event', message: `unknown event type ${body && (body as { type?: string }).type}` });
    }
    if (body.type === 'task_created') return this.reject(taskId, state, body, { code: 'use_start', message: 'tasks are created with start()' });
    const event = { ...body, at: this.now().toISOString() } as NewEvent;
    const r = transition(state, event as OrchEvent);
    if (!r.ok) return this.reject(taskId, state, body, r.error);
    const stored = await this.append(taskId, event, r.state);
    if (r.state.status === 'done' && (await this.currentTask()) === taskId) await this.clearCurrent();
    return { ok: true, event: stored, state: r.state, next: nextAction(r.state) };
  }

  async reject(taskId: string, state: TaskState | null, body: unknown, error: { code: string; message: string }): Promise<DispatchResult> {
    if (state) await this.append(taskId, { type: 'transition_rejected', event: body, code: error.code, error: error.message, at: this.now().toISOString() });
    return { ok: false, error, state };
  }

  /** Appends an informational event. These never change state, so no transition runs. */
  async record(taskId: string, body: EventBody): Promise<OrchEvent> {
    if (!INFO_EVENTS.has(body.type)) throw new Error(`${body.type} is not informational; use dispatch()`);
    return this.locked(taskId, () => this.append(taskId, { ...body, at: this.now().toISOString() } as NewEvent));
  }

  /** Every task folder, newest first. A log that does not replay shows up as `corrupt` instead of hiding. */
  async list(): Promise<TaskEntry[]> {
    const dirs = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const entries = await Promise.all(
      dirs.map(async (d): Promise<TaskEntry | null> => {
        if (!d.isDirectory() || !(await this.exists(d.name))) return null;
        try {
          return { taskId: d.name, state: await this.state(d.name) };
        } catch (e) {
          return { taskId: d.name, corrupt: true, error: (e as Error).message, at: await changedAt(path.join(this.dir(d.name), TASK_FILES.events)) };
        }
      })
    );
    return entries.filter((e): e is TaskEntry => e !== null).sort((a, b) => ((b.state && b.state.updatedAt) || b.at || '').localeCompare((a.state && a.state.updatedAt) || a.at || ''));
  }

  // ---------- which process runs a task ----------

  /**
   * Takes the task's run lease (`run.lease`: this process's pid, renewed while it runs), or says which other process
   * holds it: another VS Code window on this workspace runs the task, and running it here too would put two agents on
   * the same step in the same checkout. A lease whose process is gone, or that nobody renewed, is taken over.
   */
  async takeLease(taskId: string): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; pid: number }> {
    const file = path.join(this.dir(taskId), LEASE_FILE);
    for (;;) {
      try {
        const handle = await fs.promises.open(file, 'wx');
        await handle.writeFile(`${process.pid}\n`);
        await handle.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = await otherHolder(file, this);
        if (pid !== null) return { ok: false, pid };
        await fs.promises.rm(file, { force: true });
      }
    }
    leasesHere.set(file, this);
    const renew = setInterval(() => {
      const now = new Date();
      fs.promises.utimes(file, now, now).catch(() => undefined);
    }, LEASE_RENEW_MS);
    renew.unref();
    return {
      ok: true,
      release: async () => {
        clearInterval(renew);
        if (leasesHere.get(file) === this) leasesHere.delete(file);
        const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
        if (Number(text.trim()) === process.pid) await fs.promises.rm(file, { force: true });
      },
    };
  }

  /** The pid of another process that runs this task now, or null. */
  runsElsewhere(taskId: string): Promise<number | null> {
    return otherHolder(path.join(this.dir(taskId), LEASE_FILE), this);
  }

  /** Tasks another process runs now. */
  async runningElsewhere(): Promise<string[]> {
    const dirs = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const held = await Promise.all(dirs.filter((d) => d.isDirectory() && TASK_ID.test(d.name)).map(async (d) => ((await this.runsElsewhere(d.name)) !== null ? d.name : null)));
    return held.filter((id): id is string => id !== null);
  }

  async remove(taskId: string): Promise<void> {
    await fs.promises.rm(this.dir(taskId), { recursive: true, force: true });
    this.cache.delete(taskId);
    if ((await this.currentTask()) === null) await this.clearCurrent();
  }

  /** Artifact paths are relative to the task folder and may not leave it. */
  artifactFile(taskId: string, rel: string): string {
    const dir = this.dir(taskId);
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error(`artifact path "${rel}" leaves the task folder`);
    return abs;
  }

  async writeArtifact(taskId: string, rel: string, content: string): Promise<string> {
    const abs = this.artifactFile(taskId, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
    return abs;
  }

  async readArtifact(taskId: string, rel: string): Promise<string> {
    try {
      return await fs.promises.readFile(this.artifactFile(taskId, rel), 'utf8');
    } catch {
      return '';
    }
  }

  /** Every file in the task folder except the log and lock, relative paths. */
  async files(taskId: string): Promise<{ path: string; size: number; mtime: number }[]> {
    const dir = this.dir(taskId);
    const out: { path: string; size: number; mtime: number }[] = [];
    const walk = async (d: string): Promise<void> => {
      const entries = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'transcripts') await walk(abs);
        } else if (!['.lock', LEASE_FILE, TASK_FILES.events].includes(e.name)) {
          const st = await fs.promises.stat(abs).catch(() => null);
          if (st) out.push({ path: path.relative(dir, abs).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    await walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ---------- agent transcripts (this extension's addition: live output survives a reload) ----------

  transcriptFile(taskId: string, key: string): string {
    return this.artifactFile(taskId, `transcripts/${key}.ndjson`);
  }

  /**
   * Queues a transcript line. Lines of one tick go out in one asynchronous append, so a streaming agent never blocks
   * the extension host with a write per message. `flushTranscripts` waits for them.
   */
  appendTranscript(taskId: string, key: string, item: unknown): void {
    const file = this.transcriptFile(taskId, key);
    const lines = this.queued.get(file);
    if (lines) {
      lines.push(`${JSON.stringify(item)}\n`);
      return;
    }
    this.queued.set(file, [`${JSON.stringify(item)}\n`]);
    this.started.set(file, (this.started.get(file) ?? 0) + 1);
    const write = (this.writes.get(file) ?? Promise.resolve()).then(() => this.writeQueued(file));
    this.writes.set(file, write);
    void write.then(() => {
      if (this.writes.get(file) === write) this.writes.delete(file);
    });
  }

  private async writeQueued(file: string): Promise<void> {
    const lines = this.queued.get(file) || [];
    this.queued.delete(file);
    try {
      // Only inside a task folder that still exists: a deleted task does not come back as a folder of transcripts.
      await fs.promises.mkdir(path.dirname(file)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      await fs.promises.appendFile(file, lines.join(''));
    } catch {
      // the task was deleted meanwhile
    }
  }

  /** Resolves when every queued transcript line is on disk. */
  async flushTranscripts(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes.values()]);
  }

  /**
   * The transcript: what is on disk and what is queued for it. A write that starts while the file is read would move
   * lines from the queue into the file behind the read, so the read is done again until none did.
   */
  async readTranscript(taskId: string, key: string, limit = 1500): Promise<TranscriptItem[]> {
    const file = this.transcriptFile(taskId, key);
    let text = '';
    for (;;) {
      const writes = this.started.get(file) ?? 0;
      const pending = this.writes.get(file);
      if (pending) await pending;
      const read = await readTail(file, limit + 1);
      if ((this.started.get(file) ?? 0) !== writes || this.writes.get(file) !== undefined) continue;
      text = read + (this.queued.get(file) || []).join('');
      break;
    }
    const items: TranscriptItem[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // torn line
      }
    }
    return items.length > limit ? items.slice(-limit) : items;
  }
}

export type { DispatchResult, StartRequest, TranscriptItem };
/** When a file last changed, as an ISO time; the epoch when it is gone. */
const changedAt = (file: string): Promise<string> =>
  fs.promises.stat(file).then(
    (st) => st.mtime.toISOString(),
    () => new Date(0).toISOString()
  );

/**
 * The last `lines` lines of a file, read from its end in chunks: a long agent's transcript runs to megabytes, and a
 * step shows its tail. '' when there is no file yet.
 */
async function readTail(file: string, lines: number): Promise<string> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = await handle.stat();
    const chunks: Buffer[] = [];
    let newlines = 0;
    let pos = size;
    while (pos > 0 && newlines <= lines) {
      const len = Math.min(TAIL_CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, pos);
      chunks.unshift(buf);
      for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) newlines++;
    }
    const all = Buffer.concat(chunks);
    // Started mid-file: from the first whole line on, which also never cuts a character in two.
    return all.subarray(pos > 0 ? all.indexOf(0x0a) + 1 : 0).toString('utf8');
  } finally {
    await handle.close();
  }
}
const TAIL_CHUNK = 256 * 1024;

/** Size and mtime of a file, or '' when it is gone: enough to tell whether it changed since. */
const signatureAsync = (file: string): Promise<string> =>
  fs.promises.stat(file).then(
    (st) => `${st.size}:${st.mtimeMs}`,
    () => ''
  );

export { ORCH_DIR, withLock, EventStore, TaskService };
