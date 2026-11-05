// Small text helpers for rendering HTML strings.

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const plural = (n: number, one: string, many = `${one}es`): string => `${n} ${n === 1 ? one : many}`;

/** A short age as the design writes it: `12 min`, `3 h`, `2 d`, then the date. */
export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)} d`;
  return new Date(ms).toLocaleDateString();
}

/** `Fetched 2 min ago`, `Fetched just now`, `Never fetched`. */
export function fetchedAgo(ms: number | null, now = Date.now()): string {
  if (ms === null) return 'Never fetched';
  return now - ms < 45_000 ? 'Fetched just now' : `Fetched ${age(ms, now)} ago`;
}

/** Joins names as a sentence: `a`, `a and b`, `a, b and c`. */
export function listing(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
