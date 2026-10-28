export const BIG_SESSION_BYTES = 2 * 1024 * 1024;

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export const size = (bytes: number): string => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Two letters for an avatar: the first letters of the first two words, or the first two letters of one word. */
export function initials(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [a, b] = words;
  const letters = b ? `${a?.[0] ?? ''}${b[0] ?? ''}` : (a ?? '').slice(0, 2);
  return letters.toUpperCase() || '?';
}

/** The same folder always gets the same color, so an account is recognized by it. */
export function hueOf(key: string, hues: number): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % hues;
}
