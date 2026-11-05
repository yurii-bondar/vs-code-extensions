// A light highlighter for diff lines (design `02`: keywords, strings, comments). It reads one line at a time, so a
// block comment spanning lines is only coloured where its markers are; that is the trade for drawing any language.
import type { DiffSegment } from '../src/core/types.js';
import { esc } from './text.js';

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer del do elif else enum export extends false final finally fn for from func ' +
    'function go if impl implements import in interface is let match mod module mut new nil None not null of or package private protected pub public ' +
    'readonly return self static struct super switch this throw throws true try type typeof undefined use var void while with yield'
  ).split(' ')
);

/** Files whose lines are prose or data, which a code highlighter would only colour wrongly. */
const PLAIN = /\.(md|markdown|txt|rst|csv|tsv|log|lock|svg)$/i;
export const isPlain = (path: string): boolean => PLAIN.test(path);

const TOKEN = /(\/\/.*$|#(?![\w{[]).*$|\/\*.*?(?:\*\/|$)|--\s.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|([A-Za-z_$][\w$]*)/g;

interface Span {
  start: number;
  end: number;
  cls: string;
}

function spans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [whole, comment, string, word] = m;
    const start = m.index ?? 0;
    const cls = comment ? 'gt-tok-com' : string ? 'gt-tok-str' : word && KEYWORDS.has(word) ? 'gt-tok-kw' : null;
    if (cls) out.push({ start, end: start + whole.length, cls });
  }
  return out;
}

/**
 * A diff line's segments as HTML: syntax colours over the whole line, changed words wrapped in `gt-em`. The colours
 * are found on the joined line, so a string split by a word mark keeps its colour on both sides of it.
 */
export function lineHtml(segs: readonly DiffSegment[], plain: boolean): string {
  const text = segs.map((s) => s.text).join('');
  const colours = plain ? [] : spans(text);
  const cuts = new Set<number>([0, text.length]);
  let at = 0;
  for (const s of segs) cuts.add((at += s.text.length));
  for (const c of colours) cuts.add(c.start).add(c.end);
  const points = [...cuts].sort((a, b) => a - b);

  const changedAt = (i: number): boolean => {
    let end = 0;
    for (const s of segs) {
      end += s.text.length;
      if (i < end) return s.changed;
    }
    return false;
  };
  let out = '';
  let open = false;
  for (let k = 0; k < points.length - 1; k++) {
    const from = points[k] as number;
    const to = points[k + 1] as number;
    if (from === to) continue;
    const changed = changedAt(from);
    if (changed !== open) {
      out += changed ? '<span class="gt-em">' : '</span>';
      open = changed;
    }
    const cls = colours.find((c) => c.start <= from && to <= c.end)?.cls;
    const piece = esc(text.slice(from, to));
    out += cls ? `<span class="${cls}">${piece}</span>` : piece;
  }
  return open ? `${out}</span>` : out;
}
