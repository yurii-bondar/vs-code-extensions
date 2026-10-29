import { AREAS } from './appearance';
import { GO } from './syntax-go';
import { JSTS } from './syntax-jsts';
import type { Language, TokenItem } from './types';

export { AREAS };
export const LANGUAGES: readonly Language[] = [JSTS, GO];

const areaItems = () => AREAS.flatMap((a) => a.groups.flatMap((g) => g.items));
export const colorKeys = (): string[] => areaItems().flatMap((i) => (i.kind === 'color' ? [i.key] : []));
export const settingKeys = (): string[] => areaItems().flatMap((i) => (i.kind === 'setting' ? [i.key] : []));

export function findItem(langId: string, itemId: string): { lang: Language; item: TokenItem } | null {
  const lang = LANGUAGES.find((l) => l.id === langId);
  if (!lang) return null;
  for (const g of lang.groups) {
    const item = g.items.find((i) => i.id === itemId);
    if (item) return { lang, item };
  }
  return null;
}

export const textMateScopes = (lang: Language, item: TokenItem): string[] => item.scopes.flatMap((s) => lang.roots.map((r) => `${r} ${s}`));
export const semanticSelectors = (lang: Language, item: TokenItem): string[] => item.semantic.flatMap((s) => lang.semanticLanguages.map((l) => `${s}:${l}`));

// Every semantic selector Personify may write, so we never touch rules the user added by hand.
export function allSemanticSelectors(): Set<string> {
  return new Set(LANGUAGES.flatMap((lang) => lang.groups.flatMap((g) => g.items.flatMap((i) => semanticSelectors(lang, i)))));
}

export const sampleText = (lang: Language): string => lang.sample.join('\n').replace(/⟦[^¦]*¦([^⟧]*)⟧/g, '$1');
