// Intake: what the user typed → a task source → a ticket every agent reads first.
import type { PlanMeta, Source, Spec } from './types';

const FLAG_RE = /(^|\s)--(auto|no|only|key|effort|scenario|repos)(?=[\s=]|$)/;
import { SCENARIOS as SCENARIO_NAMES, SCENARIO_ID } from './protocol';

/** What the user typed, split into the description and the flags. */
interface Invocation {
  input: string;
  flags: { no?: string[]; only?: string[] };
  auto: boolean;
  key?: string;
  scenario?: string;
  effort?: Record<string, string>;
  /** `--repos api,web`: the repos of a pipeline without a plan stage, which has no planner to name them. */
  repos?: string[];
}

const FLAG = /^--(auto|no|only|key|effort|scenario|repos)(=|$)/;

/** How many words from `i` a flag takes: itself, and its value unless it is --auto or written `--flag=value`. 0: no flag. */
function flagSpan(words: string[], i: number): number {
  const m = (words[i] ?? '').match(FLAG);
  if (!m) return 0;
  return m[1] === 'auto' || m[2] === '=' ? 1 : 2;
}

/**
 * Parses `[flags] <input> [flags]`: `--auto`, `--no X`, `--only X,Y`, `--key=K`, `--effort high` or
 * `--effort developer=high,tester=low`, `--scenario readiness`, `--repos api,web`. Flags count only in a block at the start or the end
 * of the text; in between they are words of the description ("Add a --key option to the CLI"), which is kept verbatim,
 * line breaks and apostrophes included. `effort` comes back as `{ '*': level, <agent>: level }`; `*` means every agent.
 */
function parseInvocation(line: string): Invocation {
  if (!FLAG_RE.test(line)) return { input: line.trim(), flags: {}, auto: false };
  const found = [...line.matchAll(/\S+/g)];
  const words = found.map((m) => m[0]);
  let lead = 0;
  for (let n = flagSpan(words, 0); n && lead < words.length; n = flagSpan(words, lead)) lead += n;
  let tail = words.length;
  for (let j = Math.min(lead, words.length); j < words.length; j++) {
    if (!flagSpan(words, j)) continue;
    let k = j;
    for (let n = flagSpan(words, k); n && k < words.length; n = flagSpan(words, k)) k += n;
    if (k >= words.length) {
      tail = j;
      break;
    }
  }
  const at = (i: number): number => (i < found.length ? found[i]!.index! : line.length);
  const input = line.slice(at(Math.min(lead, words.length)), at(tail)).trim();
  const tokens = [...words.slice(0, lead), ...words.slice(tail)].map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
  const no: string[] = [];
  const only: string[] = [];
  let auto = false;
  let key: string | undefined;
  let scenario: string | undefined;
  const effort: Record<string, string> = {};
  const repos: string[] = [];
  const list = (v: string | undefined, flag: string): string[] => {
    if (!v) throw new Error(`${flag} needs ${flag === '--repos' ? 'a repo name' : 'an agent name'}`);
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    const [flag, inline] = eq > 0 ? [t.slice(0, eq), t.slice(eq + 1)] : [t, undefined];
    switch (flag) {
      case '--auto':
        auto = true;
        break;
      case '--no':
        no.push(...list(inline ?? tokens[++i], '--no'));
        break;
      case '--only':
        only.push(...list(inline ?? tokens[++i], '--only'));
        break;
      case '--repos':
        repos.push(...list(inline ?? tokens[++i], '--repos'));
        break;
      case '--effort': {
        const v = inline ?? tokens[++i];
        if (!v) throw new Error('--effort needs a level (e.g. high) or agent=level pairs');
        for (const part of v.split(',').map((x) => x.trim()).filter(Boolean)) {
          const [a, b] = part.includes('=') ? part.split('=') : ['*', part];
          effort[a!.trim()] = b!.trim();
        }
        break;
      }
      case '--key':
        key = inline ?? tokens[++i];
        if (!key) throw new Error('--key needs a value');
        break;
      case '--scenario':
        scenario = inline ?? tokens[++i];
        if (!SCENARIO_ID.test(scenario || '')) throw new Error(`--scenario names a scenario, e.g. ${SCENARIO_NAMES.join(', ')} or one of your own`);
        break;
    }
  }
  return { input, flags: { ...(no.length && { no }), ...(only.length && { only }) }, auto, ...(key && { key }), ...(scenario && { scenario }), ...(Object.keys(effort).length && { effort }), ...(repos.length && { repos: [...new Set(repos)] }) };
}

const AUDIT_WORDS = /аудит|\baudit|\bвузьк\w* місц|bottleneck/i;
const READINESS_WORDS = /готовн|\breadiness\b|\bis it (done|ready)\b|acceptance criteria|критері\w*\s+(приймання|прийняття)|критерии\s+приемки|definition of done/i;

/** What the words ask for: an audit, a readiness check, or (by default) delivering the change. */
function detectScenario(text: string): string {
  if (AUDIT_WORDS.test(text)) return 'audit';
  if (READINESS_WORDS.test(text)) return 'readiness';
  return 'deliver';
}

/** A Jira issue key: a project key (a capital letter, then capitals, digits or `_`) and a number, `CP-12`, `MY_PROJ-3`. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
/** Look like Jira keys, are not. */
const NOT_A_KEY = /^(UTF|ISO|SHA|RFC|HTTP|TLS|SSL|ES|MD|AES|RSA|CVE|GPT|COVID|IPV|IP|X)-/;

/**
 * A bare key, a Jira link (browse or `selectedIssue=`), a Confluence page link, or else plain text.
 * With `embedded`, a sentence that names exactly one issue ("CP-123 check it is ready") is that issue, and the rest of
 * the words come back as `note`. `projects` narrows which keys count.
 */
type Classified = Source;

function classifyInput(input: string, { embedded = false, projects = [] }: { embedded?: boolean; projects?: string[] } = {}): Classified {
  const text = input.trim();
  if (JIRA_KEY.test(text)) return { kind: 'jira', key: text };
  if (embedded && !/^https?:\/\/\S+$/.test(text)) {
    const hit = embeddedIssue(text, projects);
    if (hit) return hit;
  }
  let url: URL | null = null;
  try {
    if (/^https?:\/\/\S+$/.test(text)) url = new URL(text);
  } catch {
    url = null;
  }
  if (url) {
    const browse = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
    const selected = url.searchParams.get('selectedIssue');
    const key = (browse && browse[1]) || (selected && JIRA_KEY.test(selected) ? selected : undefined);
    if (key) return { kind: 'jira', key, site: url.host };
    const page = url.pathname.match(/\/wiki\/.*\/pages\/(\d+)/);
    // A page id is digits: from the path, or a `?pageId=` that is one (it becomes part of the task id).
    const query = url.searchParams.get('pageId');
    const pageId = (page && page[1]) || (query && /^\d+$/.test(query) ? query : undefined);
    if (url.pathname.startsWith('/wiki/') && pageId) return { kind: 'confluence', pageId, url: text };
  }
  return { kind: 'text', text };
}

/** Whether a Jira key's project is one of `allowed`, written in any case; an empty list allows every project. */
function projectAllowed(key: string, allowed: readonly string[]): boolean {
  const project = key.split('-')[0]!.toUpperCase();
  return !allowed.length || allowed.some((p) => p.trim().toUpperCase() === project);
}

function embeddedIssue(text: string, projects: string[]): Classified | null {
  const keys = new Map<string, Extract<Source, { kind: 'jira' }> & { raw: string }>();
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const c = classifyInput(m[0].replace(/[).,;]+$/, ''));
    if (c.kind === 'jira') keys.set(c.key, { ...c, raw: m[0] });
  }
  if (!keys.size) {
    for (const m of text.matchAll(/(?<![\w/$-])([A-Z][A-Z0-9_]+-\d+)(?![\w-])/g)) {
      const key = m[1]!;
      if (NOT_A_KEY.test(key) || !projectAllowed(key, projects)) continue;
      keys.set(key, { kind: 'jira', key, raw: key });
    }
  }
  if (keys.size !== 1) return null;
  const [{ raw, ...source }] = keys.values() as unknown as [Extract<Source, { kind: 'jira' }> & { raw: string }];
  const note = text.split(raw).join(' ').replace(/[ \t]+/g, ' ').replace(/^[\s:,.;-]+|[\s:,.;-]+$/g, '').trim();
  return { ...source, ...(note && { note }) };
}

const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (now: Date): string => `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
const SCENARIO_SUFFIX: Record<string, string> = { readiness: 'check', audit: 'audit' };

/**
 * Jira → the key, Confluence → `DOC-<pageId>`, text → `T-<YYYYMMDD-HHMM>` (UTC).
 * A report scenario gets its own id next to the delivery task: `CP-1-check`, `CHECK-<stamp>`, `AUDIT-<stamp>`.
 */
function deriveTaskId(source: Source, now: Date, scenario = 'deliver'): string {
  const suffix = SCENARIO_SUFFIX[scenario];
  switch (source.kind) {
    case 'jira':
      return suffix ? `${source.key}-${suffix}` : source.key;
    case 'confluence':
      return suffix ? `DOC-${source.pageId}-${suffix}` : `DOC-${source.pageId}`;
    default:
      return suffix ? `${suffix.toUpperCase()}-${stamp(now)}` : `T-${stamp(now)}`;
  }
}

class IntakeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The most of a ticket's description, and of its comments, that goes into the ticket every agent reads first. */
const MAX_DESCRIPTION = 40000;
const MAX_CONTEXT = 20000;

/**
 * A ticket every agent of the task reads, and every replay of its state carries: a description cut at its end, the
 * comments from their end (the latest say most), each saying so. Hundreds of bot comments cost every agent tokens.
 */
function capSpec(spec: Spec): Spec {
  const head = (text: string, max: number, what: string): string => (text.length <= max ? text : `${text.slice(0, max)}\n\n[${text.length - max} more characters of the ${what} are left out here: read the rest where the ticket is]`);
  const tail = (text: string, max: number, what: string): string => (text.length <= max ? text : `[${text.length - max} characters of the ${what} before this are left out here: read them where the ticket is]\n\n${text.slice(-max)}`);
  return {
    ...spec,
    description: head(spec.description, MAX_DESCRIPTION, 'description'),
    ...(spec.context !== undefined && { context: tail(spec.context, MAX_CONTEXT, 'comments') }),
  };
}

/** Turns a classified source into a task spec. Refuses disallowed Jira projects before any request is made. */
async function runIntake(taskId: string, source: Source, opts: { allowedProjects?: string[] | undefined; atlassian?: AtlassianClient | null | undefined } = {}): Promise<Spec> {
  switch (source.kind) {
    case 'text':
      return fromText(taskId, source);
    case 'jira': {
      const allowed = opts.allowedProjects ?? [];
      if (!projectAllowed(source.key, allowed)) {
        throw new IntakeError('project_not_allowed', `Jira project ${source.key.split('-')[0]!} is not allowed (allowed: ${allowed.join(', ')})`);
      }
      const client = requireClient(opts, source);
      const issue = await attempt(() => client.issue(source.key));
      const context = issue.comments.length
        ? `## Comments\n\n${issue.comments.map((c) => `**${c.author}** (${c.created.slice(0, 10)}):\n${c.body}`).join('\n\n')}`
        : undefined;
      return {
        id: taskId,
        source: { ...source, site: source.site ?? client.site },
        title: `${issue.key} ${issue.summary}`.trim(),
        description: issue.description,
        acceptanceCriteria: extractAcceptanceCriteria(issue.description),
        links: [{ title: issue.key, url: issue.url }, ...issue.links.map((l) => ({ title: `${l.relation} ${l.key}: ${l.summary}`, url: l.url }))],
        ...(context && { context }),
      };
    }
    case 'confluence': {
      const client = requireClient(opts, source);
      const page = await attempt(() => client.page(source.pageId));
      return {
        id: taskId,
        source,
        title: page.title,
        description: page.body,
        acceptanceCriteria: extractAcceptanceCriteria(page.body),
        links: [{ title: page.title, url: page.url }],
      };
    }
  }
  throw new IntakeError('fetch_failed', `unknown source ${(source as { kind: string }).kind}`);
}

function fromText(taskId: string, source: Extract<Source, { kind: 'text' }>): Spec {
  const firstLine = source.text.split('\n').find((l) => l.trim()) || source.text;
  const clean = firstLine.trim().replace(/^#+\s*/, '');
  const title = clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}...` : clean;
  return { id: taskId, source, title, description: source.text, acceptanceCriteria: extractAcceptanceCriteria(source.text), links: [] };
}

function requireClient(opts: { atlassian?: AtlassianClient | null | undefined }, source: Source): AtlassianClient {
  if (!opts.atlassian) throw new IntakeError('atlassian_not_configured', 'Connect Atlassian in Claudestrator settings (site, email, API token) to read Jira and Confluence');
  const other = otherSite(source, opts.atlassian.site);
  if (other) throw new IntakeError('other_site', `${source.kind === 'jira' ? source.key : 'The page'} is on ${other}, and the API token is for ${opts.atlassian.site}: reading it there would read another issue or page`);
  return opts.atlassian;
}

/**
 * The site a pasted Jira or Confluence link is on when it is not `site` (the one the API token is for), or null. The
 * same key on another site is another issue: read or commented on with that token, it would be the wrong one.
 */
function otherSite(source: Source, site: string): string | null {
  const host = (s: string): string => s.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]!.toLowerCase();
  const own = source.kind === 'jira' ? source.site : source.kind === 'confluence' ? source.url : undefined;
  return own && host(own) !== host(site) ? host(own) : null;
}

/** A REST read that failed: `atlassian_auth` when the site refused the API token (the MCP reader may still get in), else `fetch_failed`. */
async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AtlassianError && e.status === 401) throw new IntakeError('atlassian_auth', e.message);
    throw new IntakeError('fetch_failed', (e as Error).message || String(e));
  }
}

/** `ticket.md`: what every agent reads first. */
function renderTicket(spec: Spec): string {
  const parts = [`# ${spec.title}`, spec.description || '_No description._'];
  parts.push('## Acceptance criteria', spec.acceptanceCriteria.length ? spec.acceptanceCriteria.map((c) => `- ${c}`).join('\n') : '_None given._');
  if (spec.request) parts.push('## What the user asked', spec.request);
  if (spec.links.length) parts.push('## Links', spec.links.map((l) => `- [${l.title}](${l.url})`).join('\n'));
  if (spec.context) parts.push(spec.context);
  return `${parts.join('\n\n')}\n`;
}

// ---------- Atlassian text formats ----------

/** Atlassian Document Format → Markdown-ish text. Keeps headings and lists, which acceptance-criteria extraction relies on. */
function adfToText(node: unknown): string {
  return blocks(node, 0).replace(/\n{3,}/g, '\n\n').trim();
}

/** A node of Atlassian Document Format. */
interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

const kids = (n: AdfNode): AdfNode[] => n.content ?? [];

function inline(n: AdfNode): string {
  switch (n.type) {
    case 'text':
      return n.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
      return String((n.attrs && n.attrs.text) ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String((n.attrs && n.attrs.url) ?? '');
    case 'date':
      return dateOf(n.attrs && n.attrs.timestamp);
    case 'status':
      return `[${String((n.attrs && n.attrs.text) ?? '')}]`;
    default:
      return kids(n).map(inline).join('');
  }
}

function blocks(raw: unknown, depth: number): string {
  if (!raw || typeof raw !== 'object') return '';
  const n = raw as AdfNode;
  const indent = '  '.repeat(depth);
  switch (n.type) {
    case 'doc':
    case 'blockquote':
    case 'panel':
    case 'expand':
    case 'tableCell':
    case 'tableHeader':
      return kids(n).map((c) => blocks(c, depth)).join('');
    case 'paragraph':
      return `${inline(n)}\n\n`;
    case 'heading':
      return `${'#'.repeat(Number((n.attrs && n.attrs.level) ?? 1))} ${inline(n)}\n\n`;
    case 'codeBlock':
      return '```\n' + inline(n) + '\n```\n\n';
    case 'rule':
      return '---\n\n';
    case 'bulletList':
    case 'orderedList':
      return (
        kids(n)
          .map((item, i) => {
            const marker = n.type === 'orderedList' ? `${i + 1}.` : '-';
            const [first, ...rest] = kids(item);
            const head = first ? blocks(first, depth + 1).trim() : '';
            const tail = rest.map((c) => blocks(c, depth + 1)).join('').trimEnd();
            return `${indent}${marker} ${head}${tail ? `\n${tail.replace(/^(?! )/gm, `${indent}  `)}` : ''}`;
          })
          .join('\n') + '\n\n'
      );
    case 'table':
      return kids(n).map((row) => `| ${kids(row).map((cell) => blocks(cell, 0).trim().replace(/\n+/g, ' ')).join(' | ')} |`).join('\n') + '\n\n';
    // Jira's action items and decisions: a checklist, often the acceptance criteria themselves.
    case 'taskList':
    case 'decisionList':
      return (
        kids(n)
          .map((item) => {
            if (item.type === 'taskList' || item.type === 'decisionList') return blocks(item, depth + 1).trimEnd();
            const state = item.attrs && item.attrs.state;
            const mark = item.type === 'taskItem' ? (state === 'DONE' ? '[x] ' : '[ ] ') : '';
            return `${indent}- ${mark}${inline(item).trim()}`;
          })
          .join('\n') + '\n\n'
      );
    default:
      return n.content ? kids(n).map((c) => blocks(c, depth)).join('') : inline(n);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Confluence storage format (XHTML) → Markdown-ish text. Rough by design: structure, not fidelity. */
/** A character by its number, or undefined for one Unicode does not have (`&#99999999;` would throw). */
function codePoint(n: number): string | undefined {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : undefined;
}

/** An ADF date node's timestamp as YYYY-MM-DD; nothing for one that is not a time (it would throw). */
function dateOf(timestamp: unknown): string {
  const d = new Date(Number(timestamp));
  return timestamp && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

function storageToText(html: string): string {
  return html
    .replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/ac:structured-macro>/g, '\n```\n$1\n```\n')
    // Other plain-text bodies (noformat): their text is all CDATA, which the tag stripping below would drop.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '\n```\n$1\n```\n')
    // Task lists: a checklist item each, without the task's id.
    .replace(/<ac:task-id>[^<]*<\/ac:task-id>/g, '')
    .replace(/<ac:task>\s*<ac:task-status>\s*(complete|incomplete)\s*<\/ac:task-status>/g, (_, st: string) => `\n- ${st === 'complete' ? '[x]' : '[ ]'} `)
    .replace(/<ac:task>/g, '\n- ')
    .replace(/<h([1-6])[^>]*>/g, (_, l) => `\n\n${'#'.repeat(Number(l))} `)
    .replace(/<\/h[1-6]>/g, '\n\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<(br|\/p|\/tr|\/ul|\/ol)[^>]*>/g, '\n')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? codePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) ?? m : ENTITIES[e] ?? m))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const AC_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?(acceptance criteria|critères d'acceptation|критерії (?:приймання|прийняття)|критерии приемки|ac)\s*(?:\*\*)?\s*:?\s*$/i;
const ITEM = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]\])\s+(.*)$/;

/** Finds the list under an "Acceptance criteria" heading. Returns [] when the ticket has none. */
function extractAcceptanceCriteria(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => AC_HEADING.test(l));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line)) break;
    const m = line.match(ITEM);
    if (m) items.push(m[1]!.replace(/^\[[ xX]\]\s*/, '').trim());
    else if (line.trim() === '') continue;
    else if (items.length > 0 && /^\s{2,}/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else if (items.length > 0) break;
  }
  return items.filter(Boolean);
}

/** Minimal REST client: Jira Cloud v3 and Confluence Cloud v2, plus Jira comments. */
interface AtlassianAuth {
  site: string;
  email: string;
  token: string;
}

type FetchImpl = typeof globalThis.fetch;

interface ClientOptions {
  fetch?: FetchImpl;
  /** How long one request may take. */
  timeoutMs?: number;
  /** Waits between attempts; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts per request: the first one and two retries. */
const ATTEMPTS = 3;
/** Statuses that mean "try again later": the request was not handled. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** A POST that may have reached the server is never sent twice (a comment would be posted twice): only these say it was not. */
const RETRY_STATUS_POST = new Set([429, 503]);

/** Seconds from a Retry-After header (seconds or an HTTP date), capped so a request never waits long. */
function retryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const s = Number(header);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 30000) : fallbackMs;
}

/** A failed REST call. `status` is the HTTP status, or null when no answer came; the message says what to do about it. */
class AtlassianError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'AtlassianError';
    this.status = status;
  }
}

const SETTINGS = 'Settings → Jira & Confluence';

/** What a refusal means: the token, the account's access, or an issue or page that is not there for it. */
function refusal(status: number, site: string): string {
  switch (status) {
    case 401:
      return `${site} refused the API token: it may have expired, been revoked or belong to another email. Create a new one at id.atlassian.com and save it in ${SETTINGS}`;
    case 403:
      return `the API token's account has no access to this on ${site}: ask a Jira or Confluence admin for it`;
    case 404:
      return `there is no such issue or page on ${site}, or the API token's account cannot see it`;
    default:
      return '';
  }
}

/**
 * Why a request got no answer. Node's fetch says only "fetch failed" and keeps the reason in `cause`: a site that is
 * not there (ENOTFOUND), a refused connection, a certificate this machine does not trust.
 */
function unreachable(e: Error, host: string): string {
  const cause = (e as { cause?: unknown }).cause;
  const c = cause && typeof cause === 'object' ? (cause as { code?: unknown; message?: unknown; errors?: unknown }) : {};
  const code = typeof c.code === 'string' ? c.code : '';
  // Every address refused: an AggregateError with no message of its own.
  const first = Array.isArray(c.errors) && c.errors[0] instanceof Error ? c.errors[0].message : '';
  const detail = (typeof c.message === 'string' && c.message) || first;
  const why = detail && code && !detail.includes(code) ? `${code}: ${detail}` : detail || code;
  const hint = /^(ENOTFOUND|EAI_AGAIN)$/.test(code)
    ? `: is the site right? (${SETTINGS})`
    : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)
      ? ': its certificate is not trusted here (a proxy that inspects HTTPS?)'
      : '';
  return `the connection to ${host} failed: ${e.message}${why ? ` (${why})` : ''}${hint}`;
}

/** The Jira and Confluence replies, as far as this client reads them. */
interface JiraIssueReply {
  key: string;
  fields?: {
    summary?: string;
    description?: string | AdfNode | null;
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body: string | AdfNode }[] };
    issuelinks?: { type?: { outward?: string; inward?: string }; outwardIssue?: JiraLinked; inwardIssue?: JiraLinked }[];
  };
}
interface JiraLinked {
  key: string;
  fields?: { summary?: string };
}
interface ConfluencePageReply {
  id: string | number;
  title?: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

class AtlassianClient {
  auth: AtlassianAuth;
  base: string;
  fetch: FetchImpl;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;

  constructor(auth: AtlassianAuth, { fetch = globalThis.fetch, timeoutMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ClientOptions = {}) {
    this.auth = auth;
    this.base = `https://${auth.site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  get site(): string {
    return this.base.slice('https://'.length);
  }

  /**
   * One REST call with a timeout. A GET is tried again after a network error, a timeout or a "try later" status;
   * a POST only after a status that says the server did not handle it.
   */
  async request<T = unknown>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const retryable = method === 'GET' ? RETRY_STATUS : RETRY_STATUS_POST;
    const credentials = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
    // What goes into an error never carries the token, whatever a server or a library put in its text (an API token is
    // long: a short one is a test's, and hiding every "t" would garble the message).
    const fail = (what: string, status: number | null): AtlassianError =>
      new AtlassianError(`${method} ${pathAndQuery}: ${[this.auth.token, credentials].reduce((m, secret) => (secret.length >= 8 ? m.split(secret).join('***') : m), what)}`, status);
    for (let attempt = 1; ; attempt++) {
      const backoff = 1000 * 2 ** (attempt - 1);
      let res: Response;
      try {
        res = await this.fetch(`${this.base}${pathAndQuery}`, {
          method,
          headers: {
            Authorization: `Basic ${credentials}`,
            Accept: 'application/json',
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
        if (method === 'GET' && attempt < ATTEMPTS) {
          await this.sleep(backoff);
          continue;
        }
        throw fail(timedOut ? `${this.site} gave no answer in ${Math.round(this.timeoutMs / 1000)}s` : unreachable(e as Error, this.site), null);
      }
      if (!res.ok && retryable.has(res.status) && attempt < ATTEMPTS) {
        await this.sleep(retryAfterMs(res.headers.get('retry-after'), backoff));
        continue;
      }
      if (!res.ok) {
        const hint = refusal(res.status, this.site);
        throw fail(`${res.status}${res.statusText ? ` ${res.statusText}` : ''}${hint ? `: ${hint}` : ''}`, res.status);
      }
      return (await res.json()) as T;
    }
  }

  async myself(): Promise<{ name: string | undefined; email: string | undefined }> {
    const me = await this.request<{ displayName?: string; emailAddress?: string }>('GET', '/rest/api/3/myself');
    return { name: me.displayName, email: me.emailAddress };
  }

  async addComment(key: string, text: string): Promise<string> {
    const content = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ type: 'paragraph', content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]) }));
    const r = await this.request<{ id: string | number }>('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: { type: 'doc', version: 1, content } });
    return String(r.id);
  }

  async issue(key: string) {
    const data = await this.request<JiraIssueReply>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,comment,issuelinks`);
    const f = data.fields ?? {};
    const browse = (k: string): string => `${this.base}/browse/${k}`;
    return {
      key: data.key,
      url: browse(data.key),
      summary: f.summary ?? '',
      description: f.description ? (typeof f.description === 'string' ? f.description : adfToText(f.description)) : '',
      comments: ((f.comment && f.comment.comments) ?? []).map((c) => ({
        author: (c.author && c.author.displayName) ?? 'unknown',
        created: c.created ?? '',
        body: typeof c.body === 'string' ? c.body : adfToText(c.body),
      })),
      links: (f.issuelinks ?? []).flatMap((l) => {
        const other = l.outwardIssue ?? l.inwardIssue;
        if (!other) return [];
        return [{ key: other.key, summary: (other.fields && other.fields.summary) ?? '', relation: (l.outwardIssue ? l.type && l.type.outward : l.type && l.type.inward) ?? 'relates to', url: browse(other.key) }];
      }),
    };
  }

  async page(id: string) {
    const data = await this.request<ConfluencePageReply>('GET', `/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`);
    const webui = data._links && data._links.webui;
    return {
      id: String(data.id),
      title: data.title ?? '',
      url: webui ? `${this.base}/wiki${webui}` : `${this.base}/wiki/pages/${id}`,
      body: storageToText((data.body && data.body.storage && data.body.storage.value) ?? ''),
    };
  }
}

/**
 * The plan of a pipeline without a planner, from the ticket: its repos, a type and a branch slug from the title (latin
 * letters and digits; `change` when the title has none), and the title as the commit subject. A Jira ticket's title
 * starts with its key (`CP-12 Fix login`), which the branch (`fix/CP-12-…`) and the PR title (`… (CP-12)`) have
 * already: the slug and the subject take the summary after it.
 */
function planFromTicket(spec: Pick<Spec, 'title' | 'source'>, input: string, repos: string[]): PlanMeta {
  const summary = spec.source.kind === 'jira' ? withoutKey(spec.title, spec.source.key) : spec.title;
  const title = summary.replace(/\s+/g, ' ').trim().slice(0, 100);
  const slug =
    title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'change';
  const type = /\b(fix(es|ed)?|bugs?|bugfix|hotfix|regression)\b/i.test(`${title} ${input}`) || /виправ|помилк|баг/i.test(`${title} ${input}`) ? 'fix' : 'feat';
  return { type, slug, ...(title && { title }), repos: repos.map((name) => ({ name, mode: 'full' as const })), openQuestions: [] };
}

/** A title without the issue key it starts with: `CP-12 Fix login`, `[CP-12] Fix login`, `CP-12: Fix login` → `Fix login`. */
function withoutKey(title: string, key: string): string {
  const t = title.trim();
  const at = t.startsWith(`[${key}]`) ? key.length + 2 : t.startsWith(key) ? key.length : 0;
  if (!at || /[\w-]/.test(t.charAt(at))) return t;
  return t.slice(at).replace(/^[\s:–—-]+/, '');
}

export type { Classified, Invocation };
export {
  capSpec,
  planFromTicket,
  parseInvocation,
  detectScenario,
  classifyInput,
  deriveTaskId,
  IntakeError,
  runIntake,
  renderTicket,
  adfToText,
  storageToText,
  extractAcceptanceCriteria,
  otherSite,
  projectAllowed,
  AtlassianClient,
  AtlassianError,
};
