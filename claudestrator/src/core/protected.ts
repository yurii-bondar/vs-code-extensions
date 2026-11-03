// Claude Code's and VS Code's settings of a repo (`.claude/`, `.mcp.json`, `.vscode/`): their hooks, permissions, MCP
// servers and tasks act outside the sandbox, so no agent writes them. A change an agent makes to one with its file tools
// is kept, and Claudestrator puts it to you: you apply it, or leave it. Pure, so the state machine and the engine share it.
import type { Finding, ProtectedMode } from './types';

const PROTECTED_MODES: ProtectedMode[] = ['off', 'ask', 'rules'];

/** A path as a repo names it: forward slashes, no leading `./`. */
const plainPath = (file: string): string => file.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** The settings an agent's change to is kept for you, by where they sit in the repo: `.claude/…`, `.mcp.json`, `.vscode/…`. */
const SETTINGS = /^(\.claude\/.|\.vscode\/.|\.mcp\.json$)/i;

/** Whether a repo-relative path is one of those settings. */
const isProtectedFile = (file: string): boolean => SETTINGS.test(plainPath(file));

/**
 * One of them that is only instructions for agents, as `CLAUDE.md` is (which agents write): a rule of `.claude/rules/`.
 * Everything else there can run a command, start a server or change what agents may do.
 */
const isInstructionsOnly = (file: string): boolean => /^\.claude\/rules\/.+\.md$/i.test(plainPath(file)) && !plainPath(file).split('/').includes('..');

/**
 * Whether a finding is about a file no agent changes, wherever its path starts (the repo's name, `./`): a fix round would
 * end where this one did, so it goes to you.
 */
function humanFinding(f: Pick<Finding, 'file'>): boolean {
  if (!f.file) return false;
  const parts = plainPath(f.file).split('/');
  return parts.some((p, i) => /^\.(claude|vscode)$/i.test(p) && i < parts.length - 1) || /^(\.mcp\.json|CLAUDE\.local\.md)$/i.test(parts[parts.length - 1] ?? '');
}

interface EditInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean | undefined;
}

/** What an Edit makes of a file, or null where Claude Code would refuse it: its old text missing, or there more than once. */
function applyEdit(content: string, { old_string, new_string, replace_all }: EditInput): string | null {
  if (!old_string) return null;
  const first = content.indexOf(old_string);
  if (first === -1) return null;
  if (replace_all) return content.split(old_string).join(new_string);
  if (content.indexOf(old_string, first + old_string.length) !== -1) return null;
  return content.slice(0, first) + new_string + content.slice(first + old_string.length);
}

/** An Edit's input as the agent gave it, or null when it is not one. */
function editInput(v: unknown): EditInput | null {
  if (typeof v !== 'object' || v === null) return null;
  const x = v as Record<string, unknown>;
  if (typeof x.old_string !== 'string' || typeof x.new_string !== 'string') return null;
  return { old_string: x.old_string, new_string: x.new_string, ...(typeof x.replace_all === 'boolean' && { replace_all: x.replace_all }) };
}

/**
 * The content a file tool's call gives a file, from what it holds now (null: no such file): Write's content, Edit's and
 * MultiEdit's changes in turn. Null when the call would not go through as given.
 */
function contentAfter(tool: string, input: Record<string, unknown>, now: string | null): string | null {
  if (tool === 'Write') return typeof input.content === 'string' ? input.content : null;
  if (now === null) return null;
  if (tool === 'Edit') {
    const edit = editInput(input);
    return edit ? applyEdit(now, edit) : null;
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let out: string | null = now;
    for (const e of input.edits) {
      const edit = editInput(e);
      out = edit && out !== null ? applyEdit(out, edit) : null;
    }
    return out;
  }
  return null;
}

export { PROTECTED_MODES, applyEdit, contentAfter, humanFinding, isInstructionsOnly, isProtectedFile, plainPath };
