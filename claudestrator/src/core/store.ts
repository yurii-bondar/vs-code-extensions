// Task storage: `<workspace>/.orch/tasks/<id>/events.ndjson` is the source of truth and the state is
// rebuilt from it. Same layout as the claudestrator CLI and plugin, so either can pick a task up.
import * as fs from 'fs';
import * as path from 'path';
import { INFO_EVENTS, STATE_EVENTS } from './protocol';
import { replay, transition, nextAction, TASK_FILES } from './machine';
import { deriveTaskId } from './intake';
import type { TaskEntry } from './view';
import type { NextAction } from './machine';
import type { Config, Effort, EventBody, EventOf, OrchEvent, NewEvent, Pipeline, Source, TaskGroup, TaskInstruction, TaskState } from './types';
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

/**
 * Cross-process mutex on a lock file (O_EXCL create), held for a read-transition-append. Only the claudestrator CLI or
 * plugin can hold it besides this process; waiting for them is a timer, so the extension host keeps running meanwhile.
 * A lock left by a crashed process is taken over at once, one older than `staleMs` (a holder that hangs) as well.
 */
async function withLock<T>(file: string, fn: () => Promise<T>, { timeoutMs = 10000, staleMs = 10000 }: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await fs.promises.open(file, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (e) {
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

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  readAll(): OrchEvent[] {
    return this.exists() ? this.parse(fs.readFileSync(this.file, 'utf8')) : [];
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
  currentTask(): string | null {
    if (!fs.existsSync(this.currentFile)) return null;
    const id = fs.readFileSync(this.currentFile, 'utf8').trim();
    return id && TASK_ID.test(id) && this.exists(id) ? id : null;
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
  isOwnWrite(taskId: string): boolean {
    const mine = this.written.get(taskId);
    return mine !== undefined && mine === signature(path.join(this.dir(taskId), TASK_FILES.events));
  }

  exists(taskId: string): boolean {
    return TASK_ID.test(taskId) && this.store(taskId).exists();
  }

  /**
   * The id a new task gets, and whether a task with it exists (starting it then continues that task).
   * Same Jira issue or Confluence page → the same task. A description always gets a fresh id.
   * A readiness check or audit that already finished is not continued: checking again is a new run (`CP-1-check-2`).
   */
  idFor({ taskId: given, source, scenario = 'deliver' }: { taskId?: string | undefined; source: Source; scenario?: string }): { taskId: string; exists: boolean } {
    if (given) return { taskId: given, exists: this.exists(given) };
    const base = deriveTaskId(source, this.now(), scenario);
    let taskId = base;
    if (source.kind === 'text') {
      for (let n = 2; this.exists(taskId); n++) taskId = `${base}-${n}`;
      return { taskId, exists: false };
    }
    if (scenario !== 'deliver') for (let n = 2; this.exists(taskId) && this.finished(taskId); n++) taskId = `${base}-${n}`;
    return { taskId, exists: this.exists(taskId) };
  }

  /** Creates a task, or returns the existing one `idFor` points at. */
  async start(req: StartRequest): Promise<{ taskId: string; created: boolean; state: TaskState }> {
    const scenario = req.scenario || 'deliver';
    const { taskId, exists } = this.idFor({ taskId: req.taskId, source: req.source, scenario });
    if (exists) return { taskId, created: false, state: this.state(taskId) };
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
      at: this.now().toISOString(),
    };
    const r = transition(null, event);
    if (!r.ok) throw new Error(r.error.message);
    await this.ensureOrchDir();
    const id = taskId;
    return this.locked(id, async () => {
      const there = await this.current(id);
      if (there) return { taskId: id, created: false, state: there };
      await this.append(id, event);
      return { taskId: id, created: true, state: r.state };
    });
  }

  /** The task's events, read once per change of its log; callers do not change the array. */
  events(taskId: string): OrchEvent[] {
    this.state(taskId);
    return this.cache.get(taskId)!.events;
  }

  finished(taskId: string): boolean {
    try {
      return this.state(taskId).status === 'done';
    } catch {
      return false;
    }
  }

  /** Replays the log; cached by its size and mtime because the UI asks often. */
  state(taskId: string): TaskState {
    const file = path.join(this.dir(taskId), TASK_FILES.events);
    const sig = signature(file);
    if (!sig) throw new Error(`no task "${taskId}"`);
    const hit = this.cache.get(taskId);
    if (hit && hit.sig === sig) return hit.state;
    const events = this.store(taskId).readAll();
    const state = replay(events);
    this.cache.set(taskId, { sig, state, events });
    return state;
  }

  next(taskId: string): NextAction {
    return nextAction(this.state(taskId));
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
    if (r.state.status === 'done' && this.currentTask() === taskId) await this.clearCurrent();
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
  list(): TaskEntry[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && this.exists(d.name))
      .map((d) => {
        try {
          return { taskId: d.name, state: this.state(d.name) };
        } catch (e) {
          return { taskId: d.name, corrupt: true, error: (e as Error).message, at: signatureTime(path.join(this.dir(d.name), TASK_FILES.events)) };
        }
      })
      .sort((a, b) => ((b.state && b.state.updatedAt) || b.at || '').localeCompare((a.state && a.state.updatedAt) || a.at || ''));
  }

  async remove(taskId: string): Promise<void> {
    await fs.promises.rm(this.dir(taskId), { recursive: true, force: true });
    this.cache.delete(taskId);
    if (this.currentTask() === null) await this.clearCurrent();
  }

  /** Artifact paths are relative to the task folder and may not leave it. */
  artifactFile(taskId: string, rel: string): string {
    const dir = this.dir(taskId);
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error(`artifact path "${rel}" leaves the task folder`);
    return abs;
  }

  writeArtifact(taskId: string, rel: string, content: string): string {
    const abs = this.artifactFile(taskId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  readArtifact(taskId: string, rel: string): string {
    try {
      return fs.readFileSync(this.artifactFile(taskId, rel), 'utf8');
    } catch {
      return '';
    }
  }

  /** Every file in the task folder except the log and lock, relative paths. */
  files(taskId: string): { path: string; size: number; mtime: number }[] {
    const dir = this.dir(taskId);
    const out: { path: string; size: number; mtime: number }[] = [];
    const walk = (d: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'transcripts') walk(abs);
        } else if (!['.lock', TASK_FILES.events].includes(e.name)) {
          const st = fs.statSync(abs);
          out.push({ path: path.relative(dir, abs).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(dir);
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

  readTranscript(taskId: string, key: string, limit = 1500): TranscriptItem[] {
    const file = this.transcriptFile(taskId, key);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // nothing written yet
    }
    text += (this.queued.get(file) || []).join('');
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
function signatureTime(file: string): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** The same, read without blocking. */
const signatureAsync = (file: string): Promise<string> =>
  fs.promises.stat(file).then(
    (st) => `${st.size}:${st.mtimeMs}`,
    () => ''
  );

/** Size and mtime of a file, or '' when it is gone: enough to tell whether it changed since. */
function signature(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

export { ORCH_DIR, withLock, EventStore, TaskService };
