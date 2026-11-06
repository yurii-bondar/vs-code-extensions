// The syntax colors the active theme gives each catalog token, with the user's own token color settings on top,
// so the panel's code samples look like the editor. TextMate matching is simplified to what the catalog needs:
// a selector part matches a scope it is a dot-prefix of, earlier parts match ancestors, "a - b" excludes b.
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { isRecord, str } from './json';
import type { Language } from '../catalog/types';
import type { JsonObject } from './json';
import type { ThemeProblem, TokenStyle } from './types';

/** One rule of a theme's tokenColors, or of textMateRules in the user's settings. */
export interface ThemeRule {
  readonly scopes: readonly string[];
  readonly foreground: string | null;
  /** null leaves the style to rules underneath; '' clears it. */
  readonly fontStyle: string | null;
}

export interface ThemeTokens {
  readonly rules: readonly ThemeRule[];
  /** Semantic selector → style, from the theme's semanticTokenColors. */
  readonly semantic: Readonly<Record<string, TokenStyle>>;
  /** The theme turns semantic highlighting on when the setting leaves it to the theme. */
  readonly semanticHighlighting: boolean;
}

/** Reads theme files; the host passes VS Code's file system, tests a map. */
export interface ThemeFiles {
  read(file: string): Promise<string>;
}


const scopeList = (v: unknown): string[] =>
  (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []).map((s) => s.trim()).filter(Boolean);

function ruleOf(raw: unknown): ThemeRule | null {
  if (!isRecord(raw)) return null;
  const scopes = scopeList(raw.scope);
  const settings = isRecord(raw.settings) ? raw.settings : {};
  if (!scopes.length) return null;
  return { scopes, foreground: str(settings.foreground) || null, fontStyle: str(settings.fontStyle) };
}

export const parseRules = (raw: unknown): ThemeRule[] => (Array.isArray(raw) ? raw.flatMap((r) => ruleOf(r) ?? []) : []);

function semanticStyle(raw: unknown): TokenStyle | null {
  if (typeof raw === 'string') return { fg: raw, fontStyle: null };
  if (!isRecord(raw)) return null;
  const flags = ['bold', 'italic', 'underline', 'strikethrough'].filter((f) => raw[f] === true);
  const fontStyle = str(raw.fontStyle) ?? (flags.length ? flags.join(' ') : null);
  return { fg: str(raw.foreground), fontStyle };
}

/**
 * A theme file with what it includes (included rules come first, so the including theme wins).
 * `tokenColors` may name a .tmTheme file, which is not read: the result then says so.
 */
export async function loadTheme(file: string, files: ThemeFiles): Promise<{ tokens: ThemeTokens; problem: ThemeProblem }> {
  const rules: ThemeRule[] = [];
  const semantic: Record<string, TokenStyle> = {};
  let semanticHighlighting = false;
  let problem: ThemeProblem = null;
  const visit = async (f: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    if (f.toLowerCase().endsWith('.tmtheme')) {
      problem = 'tmTheme';
      return;
    }
    const parsed: unknown = jsonc.parse(await files.read(f), [], { allowTrailingComma: true });
    if (!isRecord(parsed)) {
      problem = 'unreadable';
      return;
    }
    const include = str(parsed.include);
    if (include) await visit(path.join(path.dirname(f), include), depth + 1);
    if (typeof parsed.tokenColors === 'string') await visit(path.join(path.dirname(f), parsed.tokenColors), depth + 1);
    else rules.push(...parseRules(parsed.tokenColors));
    if (isRecord(parsed.semanticTokenColors)) {
      for (const [sel, value] of Object.entries(parsed.semanticTokenColors)) {
        const style = semanticStyle(value);
        if (style) semantic[sel] = style;
      }
    }
    if (typeof parsed.semanticHighlighting === 'boolean') semanticHighlighting = parsed.semanticHighlighting;
  };
  try {
    await visit(file, 0);
  } catch {
    problem = 'unreadable';
  }
  return { tokens: { rules, semantic, semanticHighlighting }, problem };
}

// VS Code's shorthand keys in editor.tokenColorCustomizations and the scopes they stand for.
const SHORTHANDS: Readonly<Record<string, readonly string[]>> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

function customizationBlock(blk: JsonObject, isPersonify: (name: string) => boolean): ThemeRule[] {
  const rules: ThemeRule[] = [];
  for (const [key, scopes] of Object.entries(SHORTHANDS)) {
    const v = blk[key];
    const style = typeof v === 'string' ? { foreground: v, fontStyle: null } : isRecord(v) ? { foreground: str(v.foreground), fontStyle: str(v.fontStyle) } : null;
    if (style) rules.push({ scopes, ...style });
  }
  const own = Array.isArray(blk.textMateRules) ? blk.textMateRules.filter((r) => !(isRecord(r) && isPersonify(str(r.name) ?? ''))) : [];
  return [...rules, ...parseRules(own)];
}

/**
 * The user's editor.tokenColorCustomizations as rules, for all themes and then for `theme` (which wins).
 * Personify's own rules are left out: the panel draws those from its state.
 */
export function customizationRules(raw: unknown, theme: string, isPersonify: (name: string) => boolean): ThemeRule[] {
  if (!isRecord(raw)) return [];
  const forTheme = raw[`[${theme}]`];
  return [...customizationBlock(raw, isPersonify), ...(isRecord(forTheme) ? customizationBlock(forTheme, isPersonify) : [])];
}

const prefixes = (selector: string, scope: string): boolean => scope === selector || scope.startsWith(`${selector}.`);

/** How specifically `selector` matches a token whose scopes are `stack` (outermost first); null when it does not. */
export function selectorScore(selector: string, stack: readonly string[]): number | null {
  const [main = '', ...excluded] = selector.split(/\s+-\s+/);
  if (excluded.some((ex) => stack.some((s) => ex.trim().split(/\s+/).every((p) => prefixes(p, s))))) return null;
  const parts = main.trim().split(/\s+/).filter(Boolean);
  const last = parts.pop();
  const token = stack[stack.length - 1];
  if (!last || !token || !prefixes(last, token)) return null;
  // The other parts must match ancestors, in order.
  let at = stack.length - 2;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] ?? '';
    while (at >= 0 && !prefixes(part, stack[at] ?? '')) at--;
    if (at < 0) return null;
    at--;
  }
  return last.split('.').length * 100 + parts.length;
}

/** Foreground and font style resolved separately, as VS Code does: the most specific rule that sets each wins, a later one on a tie. */
export function styleFor(rules: readonly ThemeRule[], stack: readonly string[]): TokenStyle {
  let fg: { score: number; value: string | null } = { score: -1, value: null };
  let fontStyle: { score: number; value: string | null } = { score: -1, value: null };
  for (const rule of rules) {
    for (const sel of rule.scopes) {
      const score = selectorScore(sel, stack);
      if (score === null) continue;
      if (rule.foreground && score >= fg.score) fg = { score, value: rule.foreground };
      if (rule.fontStyle !== null && score >= fontStyle.score) fontStyle = { score, value: rule.fontStyle };
    }
  }
  return { fg: fg.value, fontStyle: fontStyle.value };
}

export interface ItemStylesOpts {
  tokens: ThemeTokens;
  /** The user's own token color rules, applied over the theme. */
  extra: readonly ThemeRule[];
  languages: readonly Language[];
  /** Whether semantic colors apply, after the setting and the theme have had their say. */
  semantic: boolean;
}

/** The style each catalog token gets before Personify changes it, by `langId/itemId`; tokens the theme leaves alone are absent. */
export function itemStyles({ tokens, extra, languages, semantic }: ItemStylesOpts): Record<string, TokenStyle> {
  const rules = [...tokens.rules, ...extra];
  const out: Record<string, TokenStyle> = {};
  for (const lang of languages) {
    const root = lang.roots[0] ?? '';
    for (const item of lang.groups.flatMap((g) => g.items)) {
      // The first of the item's scopes the theme styles stands for the item, as in the sample.
      let style: TokenStyle = { fg: null, fontStyle: null };
      for (const scope of item.scopes) {
        const found = styleFor(rules, [root, ...scope.split(/\s+/)]);
        if (found.fg || found.fontStyle !== null) {
          style = found;
          break;
        }
      }
      if (semantic) {
        for (const sel of item.semantic) {
          const s = lang.semanticLanguages.map((l) => tokens.semantic[`${sel}:${l}`]).find(Boolean) ?? tokens.semantic[sel];
          if (s) style = { fg: s.fg ?? style.fg, fontStyle: s.fontStyle ?? style.fontStyle };
        }
      }
      if (style.fg || style.fontStyle !== null) out[`${lang.id}/${item.id}`] = style;
    }
  }
  return out;
}
