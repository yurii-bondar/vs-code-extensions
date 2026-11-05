// Asking a host who a token belongs to, and whether an account can push to a repository (design `47`, `48`). The fetch
// is passed in, so the tests answer for the host.
import type { Account } from './types';
import type { RemoteInfo } from './accounts';

/** The part of `fetch` these calls need. */
export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const api = (provider: Account['provider'], host: string): string | null => {
  if (provider === 'github') return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
  if (provider === 'gitlab') return `https://${host}/api/v4`;
  return null;
};

const headers = (provider: Account['provider'], token: string): Record<string, string> =>
  provider === 'gitlab' ? { Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Githor' };

const field = (v: unknown, key: string): unknown => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined);

/** The login a token belongs to; null when the host refuses it or cannot be asked. */
export async function whoAmI({ fetch, provider, host, token }: { fetch: Fetch; provider: Account['provider']; host: string; token: string }): Promise<string | null> {
  const base = api(provider, host);
  if (!base) return null;
  const res = await fetch(`${base}/user`, { headers: headers(provider, token) }).catch(() => null);
  if (!res?.ok) return null;
  const login = field(await res.json(), provider === 'gitlab' ? 'username' : 'login');
  return typeof login === 'string' ? login : null;
}

/** Whether the token can push to the remote's repository; null when the host cannot tell (no API, network down). */
export async function canPush({ fetch, provider, remote, token }: { fetch: Fetch; provider: Account['provider']; remote: RemoteInfo; token: string }): Promise<boolean | null> {
  const base = api(provider, remote.host);
  if (!base) return null;
  const url = provider === 'gitlab' ? `${base}/projects/${encodeURIComponent(remote.path)}` : `${base}/repos/${remote.path}`;
  const res = await fetch(url, { headers: headers(provider, token) }).catch(() => null);
  if (!res) return null;
  if (res.status === 404 || res.status === 403) return false;
  if (!res.ok) return null;
  const body = await res.json();
  if (provider === 'gitlab') {
    const level = (k: string): number => Number(field(field(field(body, 'permissions'), k), 'access_level') ?? 0);
    // Developer (30) and above can push
    return Math.max(level('project_access'), level('group_access')) >= 30;
  }
  return field(field(body, 'permissions'), 'push') === true;
}
