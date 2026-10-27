// Intake: what the user typed → a task source → a ticket every agent reads first.

/** Splits like a shell: whitespace separates, single and double quotes group. */
import type { Source, Spec } from './types';

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) tokens.push(current);
      current = '';
      has = false;
    } else current += ch;
  }
  if (quote) throw new Error(`unclosed ${quote} quote`);
  if (has || current) tokens.push(current);
  return tokens;
}

const FLAG_RE = /(^|\s)--(auto|no|only|key|effort|scenario)(?=[\s=]|$)/;
import { SCENARIOS as SCENARIO_NAMES, SCENARIO_ID } from './protocol';

/**
 * Parses `<input> [--auto] [--no X] [--only X,Y] [--key=K] [--effort high | --effort developer=high,tester=low] [--scenario readiness]`.
 * `effort` comes back as `{ '*': level, <agent>: level }`; `*` means every agent of the task. Free text without any flag is taken
 * verbatim, so apostrophes and line breaks in a description never trip the tokenizer.
 */
/** What the user typed, split into the description and the flags. */
interface Invocation {
  input: string;
  flags: { no?: string[]; only?: string[] };
  auto: boolean;
  key?: string;
  scenario?: string;
  effort?: Record<string, string>;
}

function parseInvocation(line: string): Invocation {
  if (!FLAG_RE.test(line)) return { input: line.trim(), flags: {}, auto: false };
  const tokens = tokenize(line);
  const words: string[] = [];
  const no: string[] = [];
  const only: string[] = [];
  let auto = false;
  let key: string | undefined;
  let scenario: string | undefined;
  const effort: Record<string, string> = {};
  const list = (v: string | undefined, flag: string): string[] => {
    if (!v) throw new Error(`${flag} needs an agent name`);
    return v.split(',').map((x) => x.trim()).filter(Boolean);
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    const [flag, inline]: [string | null, string | undefined] = t.startsWith('--') ? (eq > 0 ? [t.slice(0, eq), t.slice(eq + 1)] : [t, undefined]) : [null, undefined];
    switch (flag) {
      case null:
        words.push(t);
        break;
      case '--auto':
        auto = true;
        break;
      case '--no':
        no.push(...list(inline ?? tokens[++i], '--no'));
        break;
      case '--only':
        only.push(...list(inline ?? tokens[++i], '--only'));
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
      default:
        words.push(t);
    }
  }
  return { input: words.join(' '), flags: { ...(no.length && { no }), ...(only.length && { only }) }, auto, ...(key && { key }), ...(scenario && { scenario }), ...(Object.keys(effort).length && { effort }) };
}

const AUDIT_WORDS = /аудит|\baudit|\bвузьк\w* місц|bottleneck/i;
const READINESS_WORDS = /готовн|\breadiness\b|\bis it (done|ready)\b|acceptance criteria|критері\w*\s+(приймання|прийняття)|критерии\s+приемки|definition of done/i;

/** What the words ask for: an audit, a readiness check, or (by default) delivering the change. */
function detectScenario(text: string): string {
  if (AUDIT_WORDS.test(text)) return 'audit';
  if (READINESS_WORDS.test(text)) return 'readiness';
  return 'deliver';
}

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
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
    const browse = url.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    const selected = url.searchParams.get('selectedIssue');
    const key = (browse && browse[1]) || (selected && JIRA_KEY.test(selected) ? selected : undefined);
    if (key) return { kind: 'jira', key, site: url.host };
    const page = url.pathname.match(/\/wiki\/.*\/pages\/(\d+)/);
    const pageId = (page && page[1]) || url.searchParams.get('pageId') || undefined;
    if (url.pathname.startsWith('/wiki/') && pageId) return { kind: 'confluence', pageId, url: text };
  }
  return { kind: 'text', text };
}

function embeddedIssue(text: string, projects: string[]): Classified | null {
  const keys = new Map<string, Extract<Source, { kind: 'jira' }> & { raw: string }>();
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const c = classifyInput(m[0].replace(/[).,;]+$/, ''));
    if (c.kind === 'jira') keys.set(c.key, { ...c, raw: m[0] });
  }
  if (!keys.size) {
    for (const m of text.matchAll(/(?<![\w/-])([A-Z][A-Z0-9]+-\d+)(?![\w-])/g)) {
      const key = m[1]!;
      if (NOT_A_KEY.test(key) || (projects.length && !projects.includes(key.split('-')[0]!))) continue;
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

/** Turns a classified source into a task spec. Refuses disallowed Jira projects before any request is made. */
async function runIntake(taskId: string, source: Source, opts: { allowedProjects?: string[] | undefined; atlassian?: AtlassianClient | null | undefined } = {}): Promise<Spec> {
  switch (source.kind) {
    case 'text':
      return fromText(taskId, source);
    case 'jira': {
      const project = source.key.split('-')[0]!;
      const allowed = opts.allowedProjects ?? [];
      if (allowed.length > 0 && !allowed.includes(project)) {
        throw new IntakeError('project_not_allowed', `Jira project ${project} is not allowed (allowed: ${allowed.join(', ')})`);
      }
      const client = requireClient(opts);
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
      const client = requireClient(opts);
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

function requireClient(opts: { atlassian?: AtlassianClient | null | undefined }): AtlassianClient {
  if (!opts.atlassian) throw new IntakeError('atlassian_not_configured', 'Connect Atlassian in Claudestrator settings (site, email, API token) to read Jira and Confluence');
  return opts.atlassian;
}

async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
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
      return n.attrs && n.attrs.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
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
    default:
      return n.content ? kids(n).map((c) => blocks(c, depth)).join('') : inline(n);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Confluence storage format (XHTML) → Markdown-ish text. Rough by design: structure, not fidelity. */
function storageToText(html: string): string {
  return html
    .replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/ac:structured-macro>/g, '\n```\n$1\n```\n')
    .replace(/<h([1-6])[^>]*>/g, (_, l) => `\n\n${'#'.repeat(Number(l))} `)
    .replace(/<\/h[1-6]>/g, '\n\n')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<(br|\/p|\/tr|\/ul|\/ol)[^>]*>/g, '\n')
    .replace(/<\/t[dh]>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m
    )
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

  constructor(auth: AtlassianAuth, fetchImpl?: FetchImpl) {
    this.auth = auth;
    this.base = `https://${auth.site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  get site(): string {
    return this.base.slice('https://'.length);
  }

  async request<T = unknown>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.base}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${pathAndQuery}: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
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

export type { Classified, Invocation };
export {
  tokenize,
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
  AtlassianClient,
};
