// Bitbucket Cloud: its pull requests over the REST API (it has no CLI of its own like gh or glab), with an Atlassian
// API token kept in VS Code's secret storage. Only Claudestrator calls it, never an agent.
import * as fs from 'fs';
import { ATTEMPTS, RETRY_STATUS, RETRY_STATUS_POST, retryAfterMs } from './http';
import type { ChangeRequestItem, ChangeRequests, ForgePullRequest, Posted, Remote } from './forge';
import type { InlineComment, ReviewPost } from './review';

/** An Atlassian account's email and an API token with Bitbucket's scopes (Basic auth, as Bitbucket's API takes it). */
interface BitbucketAuth {
  email: string;
  token: string;
}

type FetchImpl = typeof globalThis.fetch;

interface BitbucketClientOptions {
  fetch?: FetchImpl;
  timeoutMs?: number;
  /** Waits between attempts; tests pass one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const API = 'https://api.bitbucket.org/2.0';
const SETTINGS = 'Integrations → Bitbucket';

/** A failed call; `status` is the HTTP status, or null when no answer came. */
class BitbucketError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'BitbucketError';
    this.status = status;
  }
}

/** What a refusal means, in words that say what to do. */
function refusal(status: number): string {
  switch (status) {
    case 401:
      return `Bitbucket refused the API token: it may have expired, been revoked, lack Bitbucket's scopes, or belong to another email. Create one at id.atlassian.com (with Bitbucket scopes) and save it in ${SETTINGS}`;
    case 403:
      return "the token's account may not do this here: it needs read and write access to the repository's pull requests";
    case 404:
      return "there is no such repository or pull request, or the token's account cannot see it";
    default:
      return '';
  }
}

class BitbucketClient {
  readonly auth: BitbucketAuth;
  readonly fetch: FetchImpl;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(auth: BitbucketAuth, { fetch = globalThis.fetch, timeoutMs = 30000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: BitbucketClientOptions = {}) {
    this.auth = auth;
    this.fetch = fetch;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  /**
   * One call with a timeout. A GET is tried again after a network error, a timeout or a "try later" status; a POST or
   * PUT only after a status that says the server did not handle it (a PR would be opened twice). No error carries the token.
   */
  async request(method: 'GET' | 'POST' | 'PUT', pathAndQuery: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const retryable = method === 'GET' ? RETRY_STATUS : RETRY_STATUS_POST;
    const credentials = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
    const fail = (what: string, status: number | null): BitbucketError =>
      new BitbucketError(`${method} ${pathAndQuery.split('?')[0]}: ${[this.auth.token, credentials].reduce((m, secret) => (secret.length >= 8 ? m.split(secret).join('***') : m), what)}`, status);
    for (let attempt = 1; ; attempt++) {
      const backoff = 1000 * 2 ** (attempt - 1);
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await this.fetch(`${API}${pathAndQuery}`, {
          method,
          headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (signal && signal.aborted) throw fail('stopped', null);
        const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
        if (method === 'GET' && attempt < ATTEMPTS) {
          await this.sleep(backoff);
          continue;
        }
        throw fail(timedOut ? `Bitbucket gave no answer in ${Math.round(this.timeoutMs / 1000)}s` : `the connection to api.bitbucket.org failed: ${(e as Error).message}`, null);
      }
      if (!res.ok && retryable.has(res.status) && attempt < ATTEMPTS) {
        await this.sleep(retryAfterMs(res.headers.get('retry-after'), backoff));
        continue;
      }
      if (!res.ok) {
        // Bitbucket says why in `error.message` (a branch that is not there, a PR that exists already).
        let detail = '';
        try {
          const data = obj(await res.json());
          detail = str(obj(data.error).message);
        } catch {
          // no JSON
        }
        const hint = refusal(res.status);
        throw fail(`${res.status}${res.statusText ? ` ${res.statusText}` : ''}${detail ? `: ${detail}` : ''}${hint ? `: ${hint}` : ''}`, res.status);
      }
      return res.status === 204 ? null : res.json();
    }
  }

  /** Who the token is: for the connection test. */
  async myself(): Promise<{ name: string | undefined; email: string | undefined }> {
    const me = obj(await this.request('GET', '/user'));
    return { name: str(me.display_name) || str(me.username) || undefined, email: this.auth.email };
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A pull request's page on bitbucket.org, from its `links.html.href`. */
const pageOf = (pr: Record<string, unknown>): string => str(obj(obj(pr.links).html).href);

/** A value inside a Bitbucket query (BBQL) string: its quotes and backslashes escaped. */
const quoted = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/**
 * A Bitbucket Cloud repo's pull requests. Without a client (no token saved) nothing is opened, and `problem` says how
 * to fix it before anything is pushed.
 */
function bitbucketRequests(remote: Remote, client: BitbucketClient | null): ChangeRequests {
  const [workspace, ...rest] = remote.project.split('/');
  const repo = `/repositories/${encodeURIComponent(workspace!)}/${encodeURIComponent(rest.join('/'))}`;
  const problem = client ? null : `${remote.project} is on Bitbucket, whose pull requests Claudestrator opens with an API token: create one at id.atlassian.com (with Bitbucket's pull request and repository scopes) and save it in ${SETTINGS}`;
  const call = async <T>(fn: (c: BitbucketClient) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    if (!client) return { ok: false, error: problem! };
    try {
      return { ok: true, value: await fn(client) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };
  return {
    forge: 'bitbucket',
    noun: 'PR',
    problem,
    async findOpen(branch, signal) {
      const found = await call(async (c) => obj(await c.request('GET', `${repo}/pullrequests?state=OPEN&q=${encodeURIComponent(`source.branch.name = ${quoted(branch)}`)}`, undefined, signal)));
      if (!found.ok) return null;
      const first = obj(list(found.value.values)[0]);
      return /^https?:\/\//.test(pageOf(first)) ? pageOf(first) : null;
    },
    async create({ base, head, title, bodyFile, draft, signal }) {
      const description = await fs.promises.readFile(bodyFile, 'utf8');
      const made = await call(async (c) => obj(await c.request('POST', `${repo}/pullrequests`, { title, description, source: { branch: { name: head } }, destination: { branch: { name: base } }, draft, close_source_branch: false }, signal)));
      if (!made.ok) return made;
      return pageOf(made.value) ? { ok: true, value: pageOf(made.value) } : { ok: false, error: 'Bitbucket opened no pull request it could name' };
    },
    async setBody(url, bodyFile) {
      const id = url.match(/\/pull-requests\/(\d+)/);
      if (!id) return { ok: false, error: `${url} is not a Bitbucket pull request's address` };
      const description = await fs.promises.readFile(bodyFile, 'utf8');
      // Bitbucket's update takes the title with the description.
      return call(async (c) => {
        const pr = obj(await c.request('GET', `${repo}/pullrequests/${id[1]}`));
        await c.request('PUT', `${repo}/pullrequests/${id[1]}`, { title: str(pr.title), description });
        return true as const;
      });
    },
    async search(term) {
      const q = encodeURIComponent(`title ~ ${quoted(term)} OR description ~ ${quoted(term)}`);
      return call(async (c) => {
        const data = obj(await c.request('GET', `${repo}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=50&q=${q}`));
        return list(data.values)
          .map(obj)
          .map(
            (p): ChangeRequestItem => ({
              number: Number(p.id) || 0,
              title: str(p.title),
              url: pageOf(p),
              state: str(p.state).toLowerCase(),
              draft: p.draft === true,
              head: str(obj(obj(p.source).branch).name),
              base: str(obj(obj(p.destination).branch).name),
              // Bitbucket says when a PR last changed, not when it merged.
              mergedAt: '',
            })
          );
      });
    },
  };
}

/** A repo's path in Bitbucket's API: `/repositories/<workspace>/<repo>`. */
function repoPath(project: string): string {
  const [workspace, ...rest] = project.split('/');
  return `/repositories/${encodeURIComponent(workspace!)}/${encodeURIComponent(rest.join('/'))}`;
}

/** A pull request to review: its text and comments, and the branches and commit it is about. */
async function readBitbucketPullRequest(client: BitbucketClient, project: string, n: number): Promise<ForgePullRequest> {
  const base = `${repoPath(project)}/pullrequests/${n}`;
  const pr = obj(await client.request('GET', base));
  // Comments are a ticket's context, not the ticket: a pull request whose comments cannot be read is still read.
  const comments = await client.request('GET', `${base}/comments?pagelen=100`).then(
    (d) => list(obj(d).values).map(obj),
    () => []
  );
  return {
    title: str(pr.title),
    url: pageOf(pr) || `https://bitbucket.org/${project}/pull-requests/${n}`,
    body: str(pr.description),
    labels: [],
    comments: comments.filter((c) => c.deleted !== true).map((c) => ({ author: str(obj(c.user).display_name) || 'unknown', created: str(c.created_on), body: str(obj(c.content).raw) })),
    base: str(obj(obj(pr.destination).branch).name),
    head: str(obj(obj(pr.source).branch).name),
    headSha: str(obj(obj(pr.source).commit).hash),
  };
}

/** Each line comment on its own, then the summary, which lists the ones a line refused. */
async function postBitbucketReview(client: BitbucketClient, project: string, n: number, post: ReviewPost): Promise<Posted> {
  const endpoint = `${repoPath(project)}/pullrequests/${n}/comments`;
  const missed: InlineComment[] = [];
  for (const c of post.inline) {
    try {
      await client.request('POST', endpoint, { content: { raw: c.body }, inline: { path: c.path, to: c.line } });
    } catch {
      missed.push(c);
    }
  }
  const summary = obj(await client.request('POST', endpoint, { content: { raw: post.summary(missed) } }));
  return { url: pageOf(summary) || `https://bitbucket.org/${project}/pull-requests/${n}`, inline: post.inline.length - missed.length };
}

export type { BitbucketAuth };
export { BitbucketClient, BitbucketError, bitbucketRequests, postBitbucketReview, readBitbucketPullRequest };
