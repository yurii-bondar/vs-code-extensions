const vscode = require('vscode');
const catalog = require('./catalog');

const COLORS = 'workbench.colorCustomizations';
const TOKENS = 'editor.tokenColorCustomizations';
const SEMANTIC = 'editor.semanticTokenColorCustomizations';
const SEMANTIC_ENABLED = 'editor.semanticHighlighting.enabled';
const RULE_PREFIX = 'personify:';
const CUSTOM_PREFIX = 'personify:custom:';
const STYLES = ['bold', 'italic', 'underline', 'strikethrough'];

// Settings are read-modify-write; serializing writes keeps fast UI changes from overwriting each other.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

const cfg = () => vscode.workspace.getConfiguration();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const target = (ctx) => (ctx.scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function readAt(key, scope) {
  const info = cfg().inspect(key) || {};
  return clone(scope === 'workspace' ? info.workspaceValue : info.globalValue);
}

// ctx.theme set → values live under "[Theme Name]" inside the setting object.
function block(root, ctx, create) {
  if (!ctx.theme) return root;
  const key = `[${ctx.theme}]`;
  if (!isObject(root[key])) {
    if (!create) return {};
    root[key] = {};
  }
  return root[key];
}

function pruned(root, ctx) {
  if (ctx.theme) {
    const key = `[${ctx.theme}]`;
    if (isObject(root[key]) && !Object.keys(root[key]).length) delete root[key];
  }
  return Object.keys(root).length ? root : undefined;
}

async function updateObject(key, ctx, mutate) {
  const root = readAt(key, ctx.scope);
  const obj = isObject(root) ? root : {};
  mutate(block(obj, ctx, true));
  await cfg().update(key, pruned(obj, ctx), target(ctx));
}

// ---------- appearance ----------

function appearanceState(ctx) {
  const root = readAt(COLORS, ctx.scope);
  const blk = isObject(root) ? block(root, ctx, false) : {};
  const colors = {};
  for (const key of catalog.colorKeys()) if (typeof blk[key] === 'string') colors[key] = blk[key];

  const settings = {};
  for (const key of catalog.settingKeys()) {
    const info = cfg().inspect(key) || {};
    settings[key] = {
      value: ctx.scope === 'workspace' ? info.workspaceValue : info.globalValue,
      effective: cfg().get(key),
      def: info.defaultValue,
    };
  }
  return { colors, settings };
}

const setColors = (ctx, changes) =>
  enqueue(() =>
    updateObject(COLORS, ctx, (blk) => {
      for (const [key, value] of Object.entries(changes)) {
        if (value) blk[key] = value;
        else delete blk[key];
      }
    })
  );

const setSettings = (ctx, changes) =>
  enqueue(async () => {
    for (const [key, value] of Object.entries(changes)) {
      await cfg().update(key, value === null || value === '' ? undefined : value, target(ctx));
    }
  });

// ---------- syntax ----------

const ruleName = (langId, itemId) => `${RULE_PREFIX}${langId}/${itemId}`;
const hasStyle = (style) => style && (style.fg || typeof style.fontStyle === 'string');

function syntaxState(ctx) {
  const root = readAt(TOKENS, ctx.scope);
  const blk = isObject(root) ? block(root, ctx, false) : {};
  const items = {};
  const custom = [];
  for (const rule of Array.isArray(blk.textMateRules) ? blk.textMateRules : []) {
    if (!rule || typeof rule.name !== 'string' || !rule.name.startsWith(RULE_PREFIX)) continue;
    const s = rule.settings || {};
    const style = { fg: s.foreground, fontStyle: s.fontStyle };
    if (rule.name.startsWith(CUSTOM_PREFIX)) {
      custom.push({ id: rule.name.slice(CUSTOM_PREFIX.length), scope: [].concat(rule.scope || []).join(', '), ...style });
    } else {
      items[rule.name.slice(RULE_PREFIX.length)] = style;
    }
  }
  return { items, custom, semanticHighlighting: cfg().get(SEMANTIC_ENABLED) };
}

function tmSettings(style) {
  const out = {};
  if (style.fg) out.foreground = style.fg;
  if (typeof style.fontStyle === 'string') out.fontStyle = style.fontStyle;
  return out;
}

function semanticStyle(style) {
  const out = {};
  if (style.fg) out.foreground = style.fg;
  if (typeof style.fontStyle === 'string') {
    const set = style.fontStyle.split(/\s+/);
    for (const s of STYLES) out[s] = set.includes(s);
  }
  return out;
}

// changes: [{ langId, itemId, style|null }]
const setSyntax = (ctx, changes) =>
  enqueue(async () => {
    const resolved = changes.map((c) => ({ ...c, ...catalog.findItem(c.langId, c.itemId) })).filter((c) => c.item);
    if (!resolved.length) return;

    await updateObject(TOKENS, ctx, (blk) => {
      const names = new Set(resolved.map((c) => ruleName(c.langId, c.itemId)));
      const rules = (Array.isArray(blk.textMateRules) ? blk.textMateRules : []).filter((r) => !names.has(r && r.name));
      for (const c of resolved) {
        if (!hasStyle(c.style) || !c.item.scopes.length) continue;
        rules.push({ name: ruleName(c.langId, c.itemId), scope: catalog.textMateScopes(c.lang, c.item), settings: tmSettings(c.style) });
      }
      if (rules.length) blk.textMateRules = rules;
      else delete blk.textMateRules;
    });

    if (!resolved.some((c) => c.item.semantic.length)) return;
    await updateObject(SEMANTIC, ctx, (blk) => {
      const rules = isObject(blk.rules) ? blk.rules : {};
      for (const c of resolved) {
        for (const sel of catalog.semanticSelectors(c.lang, c.item)) {
          if (hasStyle(c.style)) rules[sel] = semanticStyle(c.style);
          else delete rules[sel];
        }
      }
      if (Object.keys(rules).length) blk.rules = rules;
      else delete blk.rules;
    });
  });

// list: [{ id, scope: "a, b", fg, fontStyle }] replaces all custom rules
const setCustom = (ctx, list) =>
  enqueue(() =>
    updateObject(TOKENS, ctx, (blk) => {
      const rules = (Array.isArray(blk.textMateRules) ? blk.textMateRules : []).filter(
        (r) => !(r && typeof r.name === 'string' && r.name.startsWith(CUSTOM_PREFIX))
      );
      for (const c of list) {
        const scope = String(c.scope || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!scope.length || !hasStyle(c)) continue;
        rules.push({ name: `${CUSTOM_PREFIX}${c.id}`, scope, settings: tmSettings(c) });
      }
      if (rules.length) blk.textMateRules = rules;
      else delete blk.textMateRules;
    })
  );

// ---------- export / import / reset ----------

function exportState(ctx) {
  const tokenRoot = readAt(TOKENS, ctx.scope);
  const tokenBlk = isObject(tokenRoot) ? block(tokenRoot, ctx, false) : {};
  const semRoot = readAt(SEMANTIC, ctx.scope);
  const semBlk = isObject(semRoot) ? block(semRoot, ctx, false) : {};
  const managed = catalog.allSemanticSelectors();
  const semantic = {};
  for (const [sel, value] of Object.entries(isObject(semBlk.rules) ? semBlk.rules : {})) if (managed.has(sel)) semantic[sel] = value;

  const { colors, settings } = appearanceState(ctx);
  const plainSettings = {};
  for (const [key, s] of Object.entries(settings)) if (s.value !== undefined) plainSettings[key] = s.value;

  return {
    colors,
    settings: plainSettings,
    textMateRules: (Array.isArray(tokenBlk.textMateRules) ? tokenBlk.textMateRules : []).filter(
      (r) => r && typeof r.name === 'string' && r.name.startsWith(RULE_PREFIX)
    ),
    semanticRules: semantic,
  };
}

const importState = (ctx, data, { replace }) =>
  enqueue(async () => {
    await updateObject(COLORS, ctx, (blk) => {
      if (replace) for (const key of catalog.colorKeys()) delete blk[key];
      Object.assign(blk, data.colors || {});
    });
    const settings = { ...(data.settings || {}) };
    if (replace) for (const key of catalog.settingKeys()) if (!(key in settings)) settings[key] = undefined;
    for (const [key, value] of Object.entries(settings)) await cfg().update(key, value, target(ctx));

    const incoming = (data.textMateRules || []).filter((r) => r && typeof r.name === 'string' && r.name.startsWith(RULE_PREFIX));
    await updateObject(TOKENS, ctx, (blk) => {
      const drop = new Set(incoming.map((r) => r.name));
      const rules = (Array.isArray(blk.textMateRules) ? blk.textMateRules : []).filter(
        (r) => !(r && typeof r.name === 'string' && (replace ? r.name.startsWith(RULE_PREFIX) : drop.has(r.name)))
      );
      rules.push(...incoming);
      if (rules.length) blk.textMateRules = rules;
      else delete blk.textMateRules;
    });
    await updateObject(SEMANTIC, ctx, (blk) => {
      const rules = isObject(blk.rules) ? blk.rules : {};
      if (replace) for (const sel of catalog.allSemanticSelectors()) delete rules[sel];
      Object.assign(rules, data.semanticRules || {});
      if (Object.keys(rules).length) blk.rules = rules;
      else delete blk.rules;
    });
  });

const resetAll = (ctx) => importState(ctx, {}, { replace: true });

// Raw values of everything Personify touches, for both scopes, so a session can be reverted.
const SNAPSHOT_KEYS = () => [COLORS, TOKENS, SEMANTIC, SEMANTIC_ENABLED, ...catalog.settingKeys()];

function snapshot() {
  const snap = {};
  for (const scope of ['user', 'workspace']) {
    snap[scope] = {};
    for (const key of SNAPSHOT_KEYS()) snap[scope][key] = readAt(key, scope);
  }
  return snap;
}

const restoreSnapshot = (snap) =>
  enqueue(async () => {
    for (const scope of ['user', 'workspace']) {
      if (scope === 'workspace' && !vscode.workspace.workspaceFolders) continue;
      for (const key of SNAPSHOT_KEYS()) {
        const current = readAt(key, scope);
        if (JSON.stringify(current) !== JSON.stringify(snap[scope][key])) await cfg().update(key, snap[scope][key], target({ scope }));
      }
    }
  });

module.exports = {
  SEMANTIC_ENABLED,
  appearanceState,
  setColors,
  setSettings,
  syntaxState,
  setSyntax,
  setCustom,
  exportState,
  importState,
  resetAll,
  snapshot,
  restoreSnapshot,
};
