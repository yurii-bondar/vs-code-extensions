// When a REST call to Atlassian or Bitbucket is tried again, and how long it waits first.

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

export { ATTEMPTS, RETRY_STATUS, RETRY_STATUS_POST, retryAfterMs };
