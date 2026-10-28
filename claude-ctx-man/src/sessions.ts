import * as fs from 'fs';
import * as path from 'path';
import { isRecord } from './json';
import type { Account, ProjectSlug, Session, SessionId } from './types';

type Entry = Record<string, unknown>;

/** Claude Code stores a session as `<config>/projects/<slug of cwd>/<session id>.jsonl`. */
export const slugFor = (p: string): ProjectSlug => p.replace(/[^a-zA-Z0-9]/g, '-') as ProjectSlug;
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

interface Meta {
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  cwd: string;
  branch: string;
}

const cache = new Map<string, { mtimeMs: number; size: number; meta: Meta }>();

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseLines(content: string): Entry[] {
  const out: Entry[] = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) out.push(entry);
    } catch {
      // partial line at a chunk edge
    }
  }
  return out;
}

const blocksOf = (e: Entry): Entry[] => {
  const message = e['message'];
  const content = isRecord(message) ? message['content'] : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

/** What a person typed in a user entry, or null for tool results, slash commands, shell output and injected reminders. */
function humanText(e: Entry): string | null {
  if (e['type'] !== 'user' || e['isMeta'] || e['isSidechain']) return null;
  const message = e['message'];
  const content = isRecord(message) ? message['content'] : undefined;
  if (Array.isArray(content) && content.some((b) => isRecord(b) && b['type'] === 'tool_result')) return null;
  const value = (typeof content === 'string' ? content : blocksOf(e).filter((b) => b['type'] === 'text').map((b) => text(b['text'])).join('\n')).trim();
  // Slash commands, ! shell output and injected reminders are wrapped in tags.
  return !value || value.startsWith('<') ? null : value;
}

function readEdges(file: string, size: number): { head: string; tail: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (len: number, pos: number): string => {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      return buf.toString('utf8');
    };
    if (size <= HEAD_BYTES + TAIL_BYTES) return { head: read(size, 0), tail: '' };
    return { head: read(HEAD_BYTES, 0), tail: read(TAIL_BYTES, size - TAIL_BYTES) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Cheap metadata from the first and last chunk of the file, cached by mtime and size. */
function sessionMeta(file: string, stat: fs.Stats, projectDir: ProjectSlug): Meta {
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;

  const { head, tail } = readEdges(file, stat.size);
  let title = '';
  let lastPrompt = '';
  let firstPrompt = '';
  let branch = '';
  const cwds: string[] = [];
  for (const e of [...parseLines(head), ...parseLines(tail)]) {
    if (e['type'] === 'ai-title' && text(e['aiTitle'])) title = text(e['aiTitle']);
    else if (e['type'] === 'summary' && text(e['summary']) && !title) title = text(e['summary']);
    else if (e['type'] === 'last-prompt' && text(e['lastPrompt'])) lastPrompt = text(e['lastPrompt']);
    if (text(e['cwd'])) cwds.push(text(e['cwd']));
    if (text(e['gitBranch'])) branch = text(e['gitBranch']);
    if (!firstPrompt) firstPrompt = humanText(e) ?? '';
  }
  // A session can start in one folder and be stored under another; trust the one matching its project folder.
  const cwd = cwds.find((c) => slugFor(c) === projectDir) ?? cwds[cwds.length - 1] ?? '';
  const meta: Meta = { title: title || firstPrompt || lastPrompt || '(untitled session)', firstPrompt, lastPrompt, cwd, branch };
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

export function listSessions(account: Account): Session[] {
  const root = path.join(account.dir, 'projects');
  let projectDirs: string[] = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const name of projectDirs) {
    const projectDir = name as ProjectSlug;
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, name)).filter((f) => SESSION_FILE.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(root, name, f);
      try {
        const stat = fs.statSync(file);
        if (!stat.size) continue;
        sessions.push({ id: f.slice(0, -6) as SessionId, file, projectDir, account, mtime: stat.mtimeMs, size: stat.size, ...sessionMeta(file, stat, projectDir) });
      } catch {
        // file vanished or unreadable
      }
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

export function inWorkspace(session: Session, folders: readonly string[]): boolean {
  return folders.some((ws) => session.projectDir === slugFor(ws) || (!!session.cwd && (session.cwd === ws || session.cwd.startsWith(ws + path.sep))));
}

export const targetFile = (session: Session, target: Account): string => path.join(target.dir, 'projects', session.projectDir, `${session.id}.jsonl`);

/** Copies the transcript plus its side folders (subagents, tool results, file history for rewind). */
export function copySession(session: Session, target: Account): void {
  const destDir = path.join(target.dir, 'projects', session.projectDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(session.file, path.join(destDir, `${session.id}.jsonl`));
  const extras = [
    [path.join(path.dirname(session.file), session.id), path.join(destDir, session.id)],
    [path.join(session.account.dir, 'file-history', session.id), path.join(target.dir, 'file-history', session.id)],
  ] as const;
  for (const [from, to] of extras) {
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true });
  }
}

// ---------- handoff ----------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters)` : s);

interface Message {
  role: 'user' | 'assistant';
  text: string;
}
interface Todo {
  status: string;
  content: string;
}

function todosOf(input: unknown): Todo[] | undefined {
  const list = isRecord(input) ? input['todos'] : undefined;
  if (!Array.isArray(list)) return undefined;
  return list.filter(isRecord).map((t) => ({ status: text(t['status']), content: text(t['content']) }));
}

function readConversation(file: string): { messages: Message[]; files: string[]; todos: Todo[] | undefined } {
  const messages: Message[] = [];
  const files = new Set<string>();
  let todos: Todo[] | undefined;
  for (const e of parseLines(fs.readFileSync(file, 'utf8'))) {
    if (e['isSidechain']) continue;
    const human = humanText(e);
    if (human) {
      messages.push({ role: 'user', text: human });
      continue;
    }
    if (e['type'] !== 'assistant') continue;
    for (const b of blocksOf(e)) {
      if (b['type'] === 'text' && text(b['text']).trim()) {
        const last = messages[messages.length - 1];
        // One reply is often split across several entries.
        if (last && last.role === 'assistant') last.text += `\n\n${text(b['text']).trim()}`;
        else messages.push({ role: 'assistant', text: text(b['text']).trim() });
      } else if (b['type'] === 'tool_use' && isRecord(b['input'])) {
        const input = b['input'];
        if (EDIT_TOOLS.has(text(b['name']))) files.add(text(input['file_path']) || text(input['notebook_path']));
        if (b['name'] === 'TodoWrite') todos = todosOf(input) ?? todos;
      }
    }
  }
  return { messages, files: [...files].filter(Boolean), todos };
}

export function buildHandoff(session: Session, { maxMessages }: { maxMessages: number }): string {
  const { messages, files, todos } = readConversation(session.file);
  const goal = messages.find((m) => m.role === 'user');
  const recent = messages.slice(-maxMessages);
  const rel = (f: string): string => (session.cwd && f.startsWith(session.cwd + path.sep) ? path.relative(session.cwd, f) : f);
  const out: string[] = [];
  out.push(`# Handoff: ${session.title}`, '');
  out.push(`> Continued from Claude Code session \`${session.id}\` (account **${session.account.label}**, last active ${new Date(session.mtime).toLocaleString()}).`);
  if (session.cwd) out.push(`> Project: \`${session.cwd}\`${session.branch ? `, branch \`${session.branch}\`` : ''}.`);
  out.push('');
  if (goal) out.push('## Original request', '', clip(goal.text, 4000), '');
  if (files.length) out.push('## Files changed so far', '', ...files.map((f) => `- \`${rel(f)}\``), '');
  if (todos?.length) {
    out.push('## Task list', '', ...todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`), '');
  }
  if (recent.length) {
    out.push(`## Recent conversation (last ${recent.length} messages)`, '');
    for (const m of recent) out.push(`### ${m.role === 'user' ? 'User' : 'Assistant'}`, '', clip(m.text, 2500), '');
  }
  out.push('## What to do next', '', 'Continue this task from where the conversation above stopped. Read the changed files before editing them, and ask if anything is unclear.', '');
  return out.join('\n');
}
