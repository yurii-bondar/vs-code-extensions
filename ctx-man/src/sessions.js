const fs = require('fs');
const path = require('path');

// Claude Code stores a session as <config>/projects/<slug of cwd>/<session id>.jsonl.
const slugFor = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

const cache = new Map();

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line at a chunk edge
    }
  }
  return out;
}

function humanText(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isSidechain) return null;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return null;
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '').trim();
  // Slash commands, ! shell output and injected reminders are wrapped in tags.
  if (!text || text.startsWith('<')) return null;
  return text;
}

function readEdges(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (len, pos) => {
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

// Cheap metadata from the first and last chunk of the file, cached by mtime + size.
function sessionMeta(file, stat, projectDir) {
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;

  const { head, tail } = readEdges(file, stat.size);
  const headEntries = parseLines(head);
  const tailEntries = parseLines(tail);
  const all = headEntries.concat(tailEntries);

  let title;
  let lastPrompt;
  let firstPrompt;
  let branch;
  const cwds = [];
  for (const e of all) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    else if (e.type === 'summary' && e.summary && !title) title = e.summary;
    else if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    if (e.cwd) cwds.push(e.cwd);
    if (e.gitBranch) branch = e.gitBranch;
    if (!firstPrompt) firstPrompt = humanText(e) || undefined;
  }
  // A session can start in one folder and be stored under another; trust the one matching its project folder.
  const cwd = cwds.find((c) => slugFor(c) === projectDir) || cwds[cwds.length - 1];
  const meta = { title: title || firstPrompt || lastPrompt || '(untitled session)', firstPrompt, lastPrompt, cwd, branch };
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

function listSessions(account) {
  const root = path.join(account.dir, 'projects');
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const sessions = [];
  for (const projectDir of projectDirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, projectDir)).filter((f) => SESSION_FILE.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(root, projectDir, f);
      try {
        const stat = fs.statSync(file);
        if (!stat.size) continue;
        sessions.push({ id: f.slice(0, -6), file, projectDir, account, mtime: stat.mtimeMs, size: stat.size, ...sessionMeta(file, stat, projectDir) });
      } catch {
        // file vanished or unreadable
      }
    }
  }
  return sessions.sort((a, b) => b.mtime - a.mtime);
}

function inWorkspace(session, folders) {
  return folders.some((ws) => session.projectDir === slugFor(ws) || (session.cwd && (session.cwd === ws || session.cwd.startsWith(ws + path.sep))));
}

const targetFile = (session, target) => path.join(target.dir, 'projects', session.projectDir, `${session.id}.jsonl`);

// Copies the transcript plus its side folders (subagents, tool results, file history for rewind).
function copySession(session, target) {
  const destDir = path.join(target.dir, 'projects', session.projectDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(session.file, path.join(destDir, `${session.id}.jsonl`));
  const extras = [
    [path.join(path.dirname(session.file), session.id), path.join(destDir, session.id)],
    [path.join(session.account.dir, 'file-history', session.id), path.join(target.dir, 'file-history', session.id)],
  ];
  for (const [from, to] of extras) {
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, force: true });
  }
}

// ---------- handoff ----------

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters)` : s);

function readConversation(file) {
  const messages = [];
  const files = new Set();
  let todos;
  for (const e of parseLines(fs.readFileSync(file, 'utf8'))) {
    if (e.isSidechain) continue;
    const human = humanText(e);
    if (human) {
      messages.push({ role: 'user', text: human });
      continue;
    }
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text && b.text.trim()) {
        const last = messages[messages.length - 1];
        // One reply is often split across several entries.
        if (last && last.role === 'assistant') last.text += `\n\n${b.text.trim()}`;
        else messages.push({ role: 'assistant', text: b.text.trim() });
      } else if (b.type === 'tool_use' && b.input) {
        if (EDIT_TOOLS.has(b.name)) files.add(b.input.file_path || b.input.notebook_path);
        if (b.name === 'TodoWrite' && Array.isArray(b.input.todos)) todos = b.input.todos;
      }
    }
  }
  return { messages, files: [...files].filter(Boolean), todos };
}

function buildHandoff(session, { maxMessages }) {
  const { messages, files, todos } = readConversation(session.file);
  const goal = messages.find((m) => m.role === 'user');
  const recent = messages.slice(-maxMessages);
  const rel = (f) => (session.cwd && f.startsWith(session.cwd + path.sep) ? path.relative(session.cwd, f) : f);
  const out = [];
  out.push(`# Handoff: ${session.title}`, '');
  out.push(`> Continued from Claude Code session \`${session.id}\` (account **${session.account.label}**, last active ${new Date(session.mtime).toLocaleString()}).`);
  if (session.cwd) out.push(`> Project: \`${session.cwd}\`${session.branch ? `, branch \`${session.branch}\`` : ''}.`);
  out.push('');
  if (goal) out.push('## Original request', '', clip(goal.text, 4000), '');
  if (files.length) out.push('## Files changed so far', '', ...files.map((f) => `- \`${rel(f)}\``), '');
  if (todos && todos.length) {
    out.push('## Task list', '', ...todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`), '');
  }
  if (recent.length) {
    out.push(`## Recent conversation (last ${recent.length} messages)`, '');
    for (const m of recent) out.push(`### ${m.role === 'user' ? 'User' : 'Assistant'}`, '', clip(m.text, 2500), '');
  }
  out.push('## What to do next', '', 'Continue this task from where the conversation above stopped. Read the changed files before editing them, and ask if anything is unclear.', '');
  return out.join('\n');
}

module.exports = { slugFor, listSessions, inWorkspace, copySession, targetFile, buildHandoff };
