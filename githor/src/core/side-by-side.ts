// A unified diff turned into the side-by-side rows of design `02`: one row per line pair, so the two sides can never
// drift apart, with the changed words of a changed line marked. Pure, so it is tested without git.
import type { DiffHunk, DiffRow, DiffSide, DiffSegment } from './types';

interface RawHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: { kind: ' ' | '-' | '+'; text: string }[];
}

/** The hunks of one file's unified diff; everything before the first `@@` (the file header) is skipped. */
export function parseHunks(diff: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let hunk: RawHunk | null = null;
  for (const line of diff.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      hunk = { header: line, oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const kind = line[0];
    if (kind === ' ' || kind === '-' || kind === '+') hunk.lines.push({ kind, text: line.slice(1) });
    // `\ No newline at end of file` and anything else carries no line
  }
  return hunks;
}

/** Words, runs of spaces, and single other characters: what a changed line is compared by. */
const tokens = (line: string): string[] => line.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];

/** Past this many tokens a line is marked as changed whole: the comparison grows with the square of the length. */
const MAX_TOKENS = 400;

/** The longest common subsequence of two token lists, as a keep-flag per token of each. */
function common(a: readonly string[], b: readonly string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = len[i] as number[];
      row[j] = a[i] === b[j] ? (len[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(len[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if ((len[i + 1]?.[j] ?? 0) >= (len[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return { a: keepA, b: keepB };
}

/**
 * Joins tokens into segments, adjacent ones with the same mark together. Spaces kept between two changed tokens count
 * as changed, so `Up to date` is one mark, not three.
 */
function segments(list: readonly string[], keep: readonly boolean[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  const changedAt = (i: number): boolean => i >= 0 && i < list.length && !keep[i];
  list.forEach((text, i) => {
    const changed = !keep[i] || (!text.trim() && changedAt(i - 1) && changedAt(i + 1));
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += text;
    else out.push({ text, changed });
  });
  return out;
}

/**
 * The changed words of a line pair. A line that shares almost nothing with its pair is not marked word by word: the
 * whole row is already a change, and marks everywhere would only be noise.
 */
export function wordDiff(before: string, after: string): { left: DiffSegment[]; right: DiffSegment[] } {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return { left: [{ text: before, changed: false }], right: [{ text: after, changed: false }] };
  const keep = common(a, b);
  const kept = keep.a.filter(Boolean).length;
  const words = (list: readonly string[], k: readonly boolean[]): number => list.filter((t, i) => k[i] && t.trim()).length;
  if (words(a, keep.a) === 0 || kept * 3 < Math.max(a.length, b.length)) return { left: [{ text: before, changed: false }], right: [{ text: after, changed: false }] };
  return { left: segments(a, keep.a), right: segments(b, keep.b) };
}

const plain = (n: number, text: string): DiffSide => ({ n, segs: [{ text, changed: false }] });

/** Hunks as side-by-side rows: context on both sides, a run of removed lines paired with the added lines after it. */
export function sideBySide(diff: string): DiffHunk[] {
  return parseHunks(diff).map((hunk) => {
    const rows: DiffRow[] = [];
    let left = hunk.oldStart;
    let right = hunk.newStart;
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; ) {
      const line = lines[i] as (typeof lines)[number];
      if (line.kind === ' ') {
        rows.push({ kind: 'same', left: plain(left++, line.text), right: plain(right++, line.text) });
        i++;
        continue;
      }
      const removed: string[] = [];
      const added: string[] = [];
      while (lines[i]?.kind === '-') removed.push((lines[i++] as (typeof lines)[number]).text);
      while (lines[i]?.kind === '+') added.push((lines[i++] as (typeof lines)[number]).text);
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        const a = removed[k];
        const b = added[k];
        if (a !== undefined && b !== undefined) {
          const words = wordDiff(a, b);
          rows.push({ kind: 'change', left: { n: left++, segs: words.left }, right: { n: right++, segs: words.right } });
        } else if (a !== undefined) rows.push({ kind: 'del', left: plain(left++, a), right: null });
        else if (b !== undefined) rows.push({ kind: 'add', left: null, right: plain(right++, b) });
      }
    }
    return { header: hunk.header, rows };
  });
}
