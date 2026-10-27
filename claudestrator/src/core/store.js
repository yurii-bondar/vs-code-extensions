// Task storage: `<workspace>/.orch/tasks/<id>/events.ndjson` is the source of truth and the state is
// rebuilt from it. Same layout as the claudestrator CLI and plugin, so either can pick a task up.
const fs = require('fs');
const path = require('path');
const { INFO_EVENTS, STATE_EVENTS } = require('./protocol');
const { replay, transition, nextAction, TASK_FILES } = require('./machine');
const { deriveTaskId } = require('./intake');

const ORCH_DIR = '.orch';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Cross-process mutex on a lock file (O_EXCL create). Synchronous on purpose: it is held only
 * for a read-transition-append, which takes milliseconds.
 */
function withLock(file, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released between our open and stat
      }
      if (age > staleMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${file}`);
      pause(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Append-only NDJSON log of one task. A torn last line (a crash mid-write) is ignored on read
 * and cut off by the next append.
 */
class EventStore {
  constructor(file) {
    this.file = file;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  readAll() {
    if (!this.exists()) return [];
    const lines = fs.readFileSync(this.file, 'utf8').split('\n').slice(0, -1);
    return lines
      .filter((line) => line.trim() !== '')
      .map((line, i) => {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          throw new Error(`${this.file}:${i + 1}: not valid JSON`);
        }
        if (!e || typeof e.type !== 'string' || typeof e.seq !== 'number') throw new Error(`${this.file}:${i + 1}: not an event`);
        return e;
      });
  }

  append(event) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.cutTornTail();
    const stored = { seq: this.readAll().length + 1, ...event };
    fs.appendFileSync(this.file, `${JSON.stringify(stored)}\n`);
    return stored;
  }

  cutTornTail() {
    if (!this.exists()) return;
    const buf = fs.readFileSync(this.file);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    fs.truncateSync(this.file, buf.lastIndexOf(0x0a) + 1);
  }
}

/** The single entry point for changing a task: validate, transition, then persist, or log the rejection. */
class TaskService {
  constructor({ workspace, now, onAppend }) {
    this.workspace = workspace;
    this.root = path.join(workspace, ORCH_DIR, 'tasks');
    this.currentFile = path.join(workspace, ORCH_DIR, 'current');
    this.now = now || (() => new Date());
    this.onAppend = onAppend;
    this.cache = new Map();
  }

  /** `.orch/` holds machine state and worktrees; it never belongs in a commit. */
  ensureOrchDir() {
    const dir = path.join(this.workspace, ORCH_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  }

  current() {
    if (!fs.existsSync(this.currentFile)) return null;
    const id = fs.readFileSync(this.currentFile, 'utf8').trim();
    return id && TASK_ID.test(id) && this.exists(id) ? id : null;
  }

  setCurrent(taskId) {
    this.ensureOrchDir();
    fs.writeFileSync(this.currentFile, `${taskId}\n`);
  }

  clearCurrent() {
    fs.rmSync(this.currentFile, { force: true });
  }

  dir(taskId) {
    if (!TASK_ID.test(taskId)) throw new Error(`invalid task id "${taskId}"`);
    return path.join(this.root, taskId);
  }

  locked(taskId, fn) {
    return withLock(path.join(this.dir(taskId), '.lock'), fn);
  }

  store(taskId) {
    const store = new EventStore(path.join(this.dir(taskId), TASK_FILES.events));
    const notify = this.onAppend;
    const append = store.append.bind(store);
    store.append = (event) => {
      const stored = append(event);
      this.cache.delete(taskId);
      if (notify) notify(taskId, stored);
      return stored;
    };
    return store;
  }

  exists(taskId) {
    return TASK_ID.test(taskId) && this.store(taskId).exists();
  }

  /**
   * The id a new task gets, and whether a task with it exists (starting it then continues that task).
   * Same Jira issue or Confluence page → the same task. A description always gets a fresh id.
   * A readiness check or audit that already finished is not continued: checking again is a new run (`CP-1-check-2`).
   */
  idFor({ taskId: given, source, scenario = 'deliver' }) {
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
  start(req) {
    const scenario = req.scenario || 'deliver';
    const { taskId, exists } = this.idFor({ taskId: req.taskId, source: req.source, scenario });
    if (exists) return { taskId, created: false, state: this.state(taskId) };
    this.dir(taskId);
    const event = {
      type: 'task_created',
      taskId,
      input: req.input,
      source: req.source,
      ...(scenario !== 'deliver' && { scenario }),
      ...(req.scenarioName && { scenarioName: req.scenarioName, scenarioLabel: req.scenarioLabel }),
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
    this.ensureOrchDir();
    const id = taskId;
    return this.locked(id, () => {
      if (this.exists(id)) return { taskId: id, created: false, state: this.state(id) };
      this.store(id).append(event);
      return { taskId: id, created: true, state: r.state };
    });
  }

  events(taskId) {
    return this.store(taskId).readAll();
  }

  finished(taskId) {
    try {
      return this.state(taskId).status === 'done';
    } catch {
      return false;
    }
  }

  /** Replays the log; cached by file size and mtime because the UI asks often. */
  state(taskId) {
    const file = path.join(this.dir(taskId), TASK_FILES.events);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`no task "${taskId}"`);
    }
    const hit = this.cache.get(taskId);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.state;
    const state = replay(this.events(taskId));
    this.cache.set(taskId, { size: stat.size, mtimeMs: stat.mtimeMs, state });
    return state;
  }

  next(taskId) {
    return nextAction(this.state(taskId));
  }

  dispatch(taskId, body) {
    return this.locked(taskId, () => this.dispatchUnlocked(taskId, body));
  }

  dispatchUnlocked(taskId, body) {
    const state = this.exists(taskId) ? replay(this.events(taskId)) : null;
    if (!body || typeof body.type !== 'string' || !STATE_EVENTS.has(body.type)) {
      return this.reject(taskId, state, body, { code: 'invalid_event', message: `unknown event type ${body && body.type}` });
    }
    if (body.type === 'task_created') return this.reject(taskId, state, body, { code: 'use_start', message: 'tasks are created with start()' });
    const event = { ...body, at: this.now().toISOString() };
    const r = transition(state, event);
    if (!r.ok) return this.reject(taskId, state, body, r.error);
    const stored = this.store(taskId).append(event);
    if (r.state.status === 'done' && this.current() === taskId) this.clearCurrent();
    return { ok: true, event: stored, state: r.state, next: nextAction(r.state) };
  }

  reject(taskId, state, body, error) {
    if (state) this.store(taskId).append({ type: 'transition_rejected', event: body, code: error.code, error: error.message, at: this.now().toISOString() });
    return { ok: false, error, state };
  }

  /** Appends an informational event. These never change state, so no transition runs. */
  record(taskId, body) {
    if (!INFO_EVENTS.has(body.type)) throw new Error(`${body.type} is not informational; use dispatch()`);
    return this.locked(taskId, () => this.store(taskId).append({ ...body, at: this.now().toISOString() }));
  }

  /** Every task folder, newest first. A log that does not replay shows up as `corrupt` instead of hiding. */
  list() {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && this.exists(d.name))
      .map((d) => {
        try {
          return { taskId: d.name, state: this.state(d.name) };
        } catch (e) {
          return { taskId: d.name, corrupt: true, error: e.message };
        }
      })
      .sort((a, b) => ((b.state && b.state.updatedAt) || '').localeCompare((a.state && a.state.updatedAt) || ''));
  }

  remove(taskId) {
    fs.rmSync(this.dir(taskId), { recursive: true, force: true });
    this.cache.delete(taskId);
    if (this.current() === null) this.clearCurrent();
  }

  /** Artifact paths are relative to the task folder and may not leave it. */
  artifactFile(taskId, rel) {
    const dir = this.dir(taskId);
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error(`artifact path "${rel}" leaves the task folder`);
    return abs;
  }

  writeArtifact(taskId, rel, content) {
    const abs = this.artifactFile(taskId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  readArtifact(taskId, rel) {
    try {
      return fs.readFileSync(this.artifactFile(taskId, rel), 'utf8');
    } catch {
      return '';
    }
  }

  /** Every file in the task folder except the log and lock, relative paths. */
  files(taskId) {
    const dir = this.dir(taskId);
    const out = [];
    const walk = (d) => {
      let entries = [];
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

  transcriptFile(taskId, key) {
    return this.artifactFile(taskId, `transcripts/${key}.ndjson`);
  }

  appendTranscript(taskId, key, item) {
    const file = this.transcriptFile(taskId, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`);
  }

  readTranscript(taskId, key, limit = 1500) {
    let text = '';
    try {
      text = fs.readFileSync(this.transcriptFile(taskId, key), 'utf8');
    } catch {
      return [];
    }
    const items = [];
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

module.exports = { ORCH_DIR, withLock, EventStore, TaskService };
