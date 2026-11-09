// Forges: GitHub and GitLab, reached through their own CLIs (gh, glab) under your login, never by an agent. Their issues
// are tasks' sources; their pull and merge requests are where a task's branches go.
import * as fs from 'fs';
import { bitbucketRequests, type BitbucketClient } from './bitbucket';
import type { ExecResult } from './git';
import type { ForgeKind, ForgeOverride, Source } from './types';

/** How a command runs: `exec` in the extension, a fake in tests. Never rejects. */
type Run = (cmd: string, args: readonly string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

type GithubSource = Extract<Source, { kind: 'github' }>;
type GitlabSource = Extract<Source, { kind: 'gitlab' }>;
type ForgeIssue = GithubSource | GitlabSource;

/**
 * A repo's origin on a forge: `project` is `owner/name` on GitHub, the full path (`group/sub/name`) on GitLab,
 * `workspace/repo` on Bitbucket.
 */
interface Remote {
  forge: ForgeKind;
  host: string;
  project: string;
}

/** A failed forge call: `cli_missing` when its CLI is not installed, `forge_auth` when it is not signed in, else `forge_failed`. */
class ForgeError extends Error {
  readonly code: 'cli_missing' | 'forge_auth' | 'forge_failed';

  constructor(code: ForgeError['code'], message: string) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
  }
}

/** The forges with a CLI of their own; Bitbucket has none, and is reached over its REST API. */
type CliForge = Exclude<ForgeKind, 'bitbucket'>;

const CLI: Record<CliForge, { cmd: string; name: string }> = {
  github: { cmd: 'gh', name: 'GitHub CLI (gh)' },
  gitlab: { cmd: 'glab', name: 'GitLab CLI (glab)' },
};

/**
 * Which forge a host is by its name: `bitbucket.org` is Bitbucket Cloud, `gitlab` in it is GitLab, `github` GitHub,
 * anything else neither (a self-managed GitLab on `git.acme.com` says so with `repos.<name>.forge`; Bitbucket Data
 * Center has another API, and is not one).
 */
function forgeOfHost(host: string): ForgeKind | null {
  if (/^bitbucket\.org(:\d+)?$/i.test(host)) return 'bitbucket';
  if (/gitlab/i.test(host)) return 'gitlab';
  if (/github/i.test(host)) return 'github';
  return null;
}

/**
 * A git remote URL as a forge project: `https://host/group/name(.git)`, `ssh://git@host[:port]/group/name.git` or
 * `git@host:group/name.git`. An http(s) URL keeps its port (the forge's web and API are there); an ssh one does not
 * (its port is ssh's). `forge` names the forge when the host does not say; null for a remote that is neither forge's.
 */
function parseRemote(url: string, forge?: ForgeOverride): Remote | null {
  const u = url.trim();
  let host: string;
  let pathname: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return null;
    }
    host = /^https?:$/.test(parsed.protocol) ? parsed.host : parsed.hostname;
    pathname = decodeURIComponent(parsed.pathname);
  } else {
    const scp = u.match(/^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/)(\S+)$/);
    if (!scp) return null;
    host = scp[1]!;
    pathname = scp[2]!;
  }
  const project = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const kind = forge ?? forgeOfHost(host);
  if (!kind || !host || !/^[^/\s]+(\/[^/\s]+)+$/.test(project)) return null;
  return { forge: kind, host: host.toLowerCase(), project };
}

/** `owner/name#12`: how a forge writes an issue of another project. */
const issueRef = (src: ForgeIssue): string => `${src.kind === 'github' ? src.repo : src.project}#${src.number}`;

// ---------- issues ----------

interface IssueComment {
  author: string;
  created: string;
  body: string;
}

/** An issue as a ticket needs it. */
interface ForgeIssueRead {
  title: string;
  url: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
}

/** The most comments read of an issue: the latest say most, and every agent reads them. */
const MAX_COMMENTS = 100;

/** What a failed CLI call means, in words that say what to do. */
function failure(forge: CliForge, res: ExecResult, what: string): ForgeError {
  const cli = CLI[forge];
  if (res.code === 127) return new ForgeError('cli_missing', `${cli.name} is not installed: install it and run ${cli.cmd} auth login to ${what}`);
  const text = `${res.stderr}\n${res.stdout}`.trim();
  const last = text.split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(0, 500);
  if (/auth login|not logged in|authenticat|401 Unauthorized/i.test(text)) return new ForgeError('forge_auth', `${cli.name} is not signed in here (${last}): run ${cli.cmd} auth login to ${what}`);
  return new ForgeError('forge_failed', `${cli.cmd} could not ${what}: ${last || `it exited with ${res.code}`}`);
}

function parseJson(res: ExecResult, forge: CliForge, what: string): unknown {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new ForgeError('forge_failed', `${CLI[forge].cmd} gave no JSON when asked to ${what}: ${res.stdout.slice(0, 200)}`);
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The project's path as GitLab's API takes it in a URL: `group%2Fsub%2Fname`. */
const gitlabProject = (project: string): string => `projects/${encodeURIComponent(project)}`;

/** A `glab api` call against the project's own host, which may be another than glab's default. */
function glabApi(run: Run, host: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return run('glab', ['api', '--hostname', host, ...args], { timeoutMs: 60000, ...opts });
}

/** Reads an issue with the forge's CLI: title, body, labels and comments (GitLab's system notes left out). */
async function readIssue(src: ForgeIssue, run: Run): Promise<ForgeIssueRead> {
  const what = `read ${issueRef(src)}`;
  if (src.kind === 'github') {
    const repo = src.host === 'github.com' ? src.repo : `${src.host}/${src.repo}`;
    const res = await run('gh', ['issue', 'view', String(src.number), '--repo', repo, '--json', 'title,body,url,labels,comments'], { timeoutMs: 60000 });
    if (res.code !== 0) throw failure('github', res, what);
    const data = obj(parseJson(res, 'github', what));
    return {
      title: str(data.title),
      url: str(data.url) || `https://${src.host}/${src.repo}/issues/${src.number}`,
      body: str(data.body),
      labels: list(data.labels).map((l) => str(obj(l).name)).filter(Boolean),
      comments: list(data.comments)
        .slice(-MAX_COMMENTS)
        .map((c) => ({ author: str(obj(obj(c).author).login) || 'unknown', created: str(obj(c).createdAt), body: str(obj(c).body) })),
    };
  }
  const base = `${gitlabProject(src.project)}/issues/${src.number}`;
  const [issue, notes] = await Promise.all([glabApi(run, src.host, [base]), glabApi(run, src.host, [`${base}/notes?sort=asc&order_by=created_at&per_page=${MAX_COMMENTS}`])]);
  if (issue.code !== 0) throw failure('gitlab', issue, what);
  const data = obj(parseJson(issue, 'gitlab', what));
  // Comments are a ticket's context, not the ticket: an issue whose notes cannot be read is still read.
  const raw = notes.code === 0 ? list(parseJson(notes, 'gitlab', what)) : [];
  return {
    title: str(data.title),
    url: str(data.web_url) || `https://${src.host}/${src.project}/-/issues/${src.number}`,
    body: str(data.description),
    labels: list(data.labels).map(str).filter(Boolean),
    comments: raw
      .map(obj)
      .filter((n) => n.system !== true)
      .map((n) => ({ author: str(obj(n.author).username) || 'unknown', created: str(n.created_at), body: str(n.body) })),
  };
}

// ---------- pull and merge requests ----------

/** A PR or MR, as a readiness check lists it. */
interface ChangeRequestItem {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  base: string;
  mergedAt: string;
}

interface CreateArgs {
  base: string;
  head: string;
  title: string;
  /** The description, a Markdown file. */
  bodyFile: string;
  draft: boolean;
  signal?: AbortSignal;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** A repo's pull requests (GitHub, Bitbucket) or merge requests (GitLab). */
interface ChangeRequests {
  readonly forge: ForgeKind;
  /** `PR` or `MR`, as the forge calls them. */
  readonly noun: 'PR' | 'MR';
  /** Why nothing could be opened here (Bitbucket without a token), asked before anything is pushed; null when it can. */
  readonly problem: string | null;
  /** The open one from `branch`, or null: a retry after a partial publish finds what it opened. */
  findOpen(branch: string, signal?: AbortSignal): Promise<string | null>;
  create(args: CreateArgs): Promise<Outcome<string>>;
  setBody(url: string, bodyFile: string): Promise<Outcome<true>>;
  /** Those that mention `term` (an issue key), open or not. */
  search(term: string): Promise<Outcome<ChangeRequestItem[]>>;
}

const lastLines = (res: ExecResult): string => (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' ');

/** GitHub, as Claudestrator always opened PRs: `gh` in the repo, which finds its project from the checkout. */
function githubRequests(dir: string, run: Run): ChangeRequests {
  const gh = (args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> => run('gh', args, { cwd: dir, timeoutMs: 60000, ...opts });
  return {
    forge: 'github',
    noun: 'PR',
    problem: null,
    async findOpen(branch, signal) {
      const res = await gh(['pr', 'view', branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'], signal ? { signal } : {});
      return res.code === 0 && /^https?:\/\//.test(res.stdout.trim()) ? res.stdout.trim() : null;
    },
    async create({ base, head, title, bodyFile, draft, signal }) {
      const res = await gh(['pr', 'create', ...(draft ? ['--draft'] : []), '--base', base, '--head', head, '--title', title, '--body-file', bodyFile], { timeoutMs: 120000, ...(signal && { signal }) });
      if (res.code !== 0) return { ok: false, error: res.stderr.trim() || res.stdout.trim() };
      const url = res.stdout.trim().split('\n').reverse().find((l) => /^https?:\/\//.test(l.trim()));
      return { ok: true, value: url ? url.trim() : res.stdout.trim() };
    },
    async setBody(url, bodyFile) {
      const res = await gh(['pr', 'edit', url, '--body-file', bodyFile], { timeoutMs: 120000 });
      return res.code === 0 ? { ok: true, value: true } : { ok: false, error: lastLines(res) || `gh exited with ${res.code}` };
    },
    async search(term) {
      const res = await gh(['pr', 'list', '--search', term, '--state', 'all', '--limit', '50', '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,mergedAt']);
      if (res.code !== 0) return { ok: false, error: lastLines(res) || `gh exited with ${res.code}` };
      let data: unknown;
      try {
        data = JSON.parse(res.stdout);
      } catch {
        data = null;
      }
      return {
        ok: true,
        value: list(data).map(obj).map((p) => ({
          number: Number(p.number) || 0,
          title: str(p.title),
          url: str(p.url),
          state: str(p.state).toLowerCase(),
          draft: p.isDraft === true,
          head: str(p.headRefName),
          base: str(p.baseRefName),
          mergedAt: str(p.mergedAt),
        })),
      };
    },
  };
}

/**
 * GitLab, over its REST API through `glab api` on the project's host: no prompt to answer, and the same calls on every
 * glab version. A draft is an MR whose title starts with `Draft:`, which every GitLab reads.
 */
function gitlabRequests(remote: Remote, dir: string, run: Run): ChangeRequests {
  const project = gitlabProject(remote.project);
  const api = (args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> => glabApi(run, remote.host, args, { cwd: dir, ...opts });
  /** A JSON request body, written next to the Markdown file it is made from (Claudestrator's own temp folder). */
  const send = async (method: 'POST' | 'PUT', endpoint: string, bodyFile: string, fields: Record<string, string>, signal?: AbortSignal): Promise<ExecResult> => {
    const description = await fs.promises.readFile(bodyFile, 'utf8');
    const input = `${bodyFile}.${method.toLowerCase()}.json`;
    await fs.promises.writeFile(input, JSON.stringify({ ...fields, description }));
    return api(['--method', method, '--header', 'Content-Type: application/json', '--input', input, endpoint], { timeoutMs: 120000, ...(signal && { signal }) });
  };
  return {
    forge: 'gitlab',
    noun: 'MR',
    problem: null,
    async findOpen(branch, signal) {
      const res = await api([`${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`], signal ? { signal } : {});
      if (res.code !== 0) return null;
      try {
        const first = obj(list(JSON.parse(res.stdout))[0]);
        return /^https?:\/\//.test(str(first.web_url)) ? str(first.web_url) : null;
      } catch {
        return null;
      }
    },
    async create({ base, head, title, bodyFile, draft, signal }) {
      const res = await send('POST', `${project}/merge_requests`, bodyFile, { source_branch: head, target_branch: base, title: draft ? `Draft: ${title}` : title }, signal);
      if (res.code !== 0) return { ok: false, error: failure('gitlab', res, `open a merge request from ${head}`).message };
      try {
        const url = str(obj(JSON.parse(res.stdout)).web_url);
        if (url) return { ok: true, value: url };
      } catch {
        // below
      }
      return { ok: false, error: `glab opened no merge request it could name: ${res.stdout.slice(0, 200)}` };
    },
    async setBody(url, bodyFile) {
      const iid = url.match(/\/merge_requests\/(\d+)/);
      if (!iid) return { ok: false, error: `${url} is not a merge request's address` };
      const res = await send('PUT', `${project}/merge_requests/${iid[1]}`, bodyFile, {});
      return res.code === 0 ? { ok: true, value: true } : { ok: false, error: lastLines(res) || `glab exited with ${res.code}` };
    },
    async search(term) {
      const res = await api([`${project}/merge_requests?state=all&in=title,description&per_page=50&search=${encodeURIComponent(term)}`]);
      if (res.code !== 0) return { ok: false, error: failure('gitlab', res, 'list merge requests').message };
      let data: unknown;
      try {
        data = JSON.parse(res.stdout);
      } catch {
        data = null;
      }
      return {
        ok: true,
        value: list(data).map(obj).map((m) => ({
          number: Number(m.iid) || 0,
          title: str(m.title),
          url: str(m.web_url),
          state: str(m.state),
          draft: m.draft === true || m.work_in_progress === true,
          head: str(m.source_branch),
          base: str(m.target_branch),
          mergedAt: str(m.merged_at),
        })),
      };
    },
  };
}

interface ChangeRequestsArgs {
  remote: Remote | null;
  dir: string;
  run: Run;
  /** Bitbucket Cloud's REST client, when a token is saved. */
  bitbucket?: BitbucketClient | null | undefined;
}

/** A repo's PRs or MRs, by its origin: GitLab's, Bitbucket's, else GitHub's (as before there were others). */
function changeRequests({ remote, dir, run, bitbucket }: ChangeRequestsArgs): ChangeRequests {
  if (remote && remote.forge === 'gitlab') return gitlabRequests(remote, dir, run);
  if (remote && remote.forge === 'bitbucket') return bitbucketRequests(remote, bitbucket ?? null);
  return githubRequests(dir, run);
}

/**
 * The line of a PR's description that ties it to the task's issue on the same forge: `Closes #12` (or `owner/name#12`
 * from another project), which closes the issue when it merges. With several PRs it is `Refs`: the first to merge
 * would close an issue the others are still part of. Nothing for an issue elsewhere (its link is in the description).
 */
function issueLine(source: Source, remote: Remote | null, prs: number): string | undefined {
  if ((source.kind !== 'github' && source.kind !== 'gitlab') || !remote || remote.forge !== source.kind || remote.host !== source.host.toLowerCase()) return undefined;
  const project = source.kind === 'github' ? source.repo : source.project;
  const ref = project.toLowerCase() === remote.project.toLowerCase() ? `#${source.number}` : issueRef(source);
  return `${prs > 1 ? 'Refs' : 'Closes'} ${ref}`;
}

export type { ChangeRequestItem, ChangeRequests, CreateArgs, ForgeIssue, ForgeIssueRead, Outcome, Remote, Run };
export { CLI, ForgeError, changeRequests, forgeOfHost, issueLine, issueRef, parseRemote, readIssue };
