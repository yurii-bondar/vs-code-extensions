const AREAS = require('./appearance');
const LANGUAGES = [require('./syntax-jsts'), require('./syntax-go')];

const colorKeys = () => AREAS.flatMap((a) => a.groups.flatMap((g) => g.items.filter((i) => i.kind === 'color').map((i) => i.key)));
const settingKeys = () => AREAS.flatMap((a) => a.groups.flatMap((g) => g.items.filter((i) => i.kind === 'setting').map((i) => i.key)));

function findItem(langId, itemId) {
  const lang = LANGUAGES.find((l) => l.id === langId);
  if (!lang) return {};
  for (const g of lang.groups) {
    const item = g.items.find((i) => i.id === itemId);
    if (item) return { lang, item };
  }
  return { lang };
}

const textMateScopes = (lang, item) => item.scopes.flatMap((s) => lang.roots.map((r) => `${r} ${s}`));
const semanticSelectors = (lang, item) => item.semantic.flatMap((s) => lang.semanticLanguages.map((l) => `${s}:${l}`));

// Every semantic selector Personify may write, so we never touch rules the user added by hand.
function allSemanticSelectors() {
  return new Set(LANGUAGES.flatMap((lang) => lang.groups.flatMap((g) => g.items.flatMap((i) => semanticSelectors(lang, i)))));
}

const sampleText = (lang) => lang.sample.join('\n').replace(/⟦[^¦]*¦([^⟧]*)⟧/g, '$1');

module.exports = { AREAS, LANGUAGES, colorKeys, settingKeys, findItem, textMateScopes, semanticSelectors, allSemanticSelectors, sampleText };
