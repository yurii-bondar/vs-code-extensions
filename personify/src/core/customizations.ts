// What Personify writes to settings: colors, plain settings and syntax rules, read and changed at one target.
import * as catalog from '../catalog';
import { isRecord, str } from './json';
import type { JsonObject } from './json';
import type { AppearanceState, CustomRule, Scope, SettingState, SettingValue, SyntaxChange, SyntaxState, Target, TokenStyle } from './types';

export const COLORS = 'workbench.colorCustomizations';
export const TOKENS = 'editor.tokenColorCustomizations';
export const SEMANTIC = 'editor.semanticTokenColorCustomizations';
export const SEMANTIC_ENABLED = 'editor.semanticHighlighting.enabled';
const RULE_PREFIX = 'personify:';
const CUSTOM_PREFIX = 'personify:custom:';
const STYLES = ['bold', 'italic', 'underline', 'strikethrough'];
const SCOPES: readonly Scope[] = ['user', 'workspace'];

/** VS Code settings, as far as Personify needs them. */
export interface Config {
  /** The value written at that level; undefined when it is not set there. */
  read(key: string, scope: Scope): unknown;
  /** What applies right now, from any level. */
  effective(key: string): unknown;
  defaultValue(key: string): unknown;
  /** undefined removes the setting from that level. */
  write(key: string, value: unknown, scope: Scope): Promise<void>;
  canWriteWorkspace(): boolean;
}

/** What a profile file carries besides keybindings. */
export interface Customization {
  readonly colors: Readonly<Record<string, string>>;
  readonly settings: Readonly<Record<string, SettingValue>>;
  /** Only rules named `personify:…` are used. */
  readonly textMateRules: readonly JsonObject[];
  /** By semantic selector; only selectors from the catalog are used. */
  readonly semanticRules: Readonly<JsonObject>;
}

/** Raw values of every key Personify touches, at both levels, so a session can be reverted. */
export type Snapshot = Record<Scope, Record<string, unknown>>;

export const settingValue = (v: unknown): SettingValue | null => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null);
const clone = (v: unknown): unknown => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown));
const rulesOf = (blk: JsonObject): unknown[] => (Array.isArray(blk.textMateRules) ? blk.textMateRules : []);
const nameOf = (rule: unknown): string | null => (isRecord(rule) ? str(rule.name) : null);
const ruleName = (langId: string, itemId: string): string => `${RULE_PREFIX}${langId}/${itemId}`;
export const hasStyle = (style: TokenStyle | null): boolean => !!style && (!!style.fg || style.fontStyle !== null);
const scopeList = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function setRules(blk: JsonObject, rules: unknown[]): void {
  if (rules.length) blk.textMateRules = rules;
  else delete blk.textMateRules;
}

function setSemanticRules(blk: JsonObject, rules: JsonObject): void {
  if (Object.keys(rules).length) blk.rules = rules;
  else delete blk.rules;
}

// A theme set → values live under "[Theme Name]" inside the setting object.
export function block(root: JsonObject, theme: string | null, create: boolean): JsonObject {
  if (!theme) return root;
  const key = `[${theme}]`;
  const existing = root[key];
  if (isRecord(existing)) return existing;
  const fresh: JsonObject = {};
  if (create) root[key] = fresh;
  return fresh;
}

/** The setting object to write back: the theme block dropped when it is empty, undefined when nothing is left. */
export function pruned(root: JsonObject, theme: string | null): JsonObject | undefined {
  if (theme) {
    const key = `[${theme}]`;
    const blk = root[key];
    if (isRecord(blk) && !Object.keys(blk).length) delete root[key];
  }
  return Object.keys(root).length ? root : undefined;
}

export function tmSettings(style: TokenStyle): JsonObject {
  const out: JsonObject = {};
  if (style.fg) out.foreground = style.fg;
  if (style.fontStyle !== null) out.fontStyle = style.fontStyle;
  return out;
}

export function semanticStyle(style: TokenStyle): JsonObject {
  const out: JsonObject = {};
  if (style.fg) out.foreground = style.fg;
  if (style.fontStyle !== null) {
    const set = style.fontStyle.split(/\s+/);
    for (const s of STYLES) out[s] = set.includes(s);
  }
  return out;
}

const EMPTY: Customization = { colors: {}, settings: {}, textMateRules: [], semanticRules: {} };

export class Customizations {
  // Settings are read-modify-write; serializing writes keeps fast UI changes from overwriting each other.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {}

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private readAt(key: string, scope: Scope): unknown {
    return clone(this.config.read(key, scope));
  }

  /** The object of `key` at the target, for reading; empty when nothing is set. */
  private blockAt(key: string, target: Target): JsonObject {
    const root = this.readAt(key, target.scope);
    return isRecord(root) ? block(root, target.theme, false) : {};
  }

  private async updateObject(key: string, target: Target, mutate: (blk: JsonObject) => void): Promise<void> {
    const root = this.readAt(key, target.scope);
    const obj = isRecord(root) ? root : {};
    mutate(block(obj, target.theme, true));
    await this.config.write(key, pruned(obj, target.theme), target.scope);
  }

  // ---------- appearance ----------

  appearanceState(target: Target): AppearanceState {
    const blk = this.blockAt(COLORS, target);
    const colors: Record<string, string> = {};
    for (const key of catalog.colorKeys()) {
      const value = blk[key];
      if (typeof value === 'string') colors[key] = value;
    }
    const settings: Record<string, SettingState> = {};
    for (const key of catalog.settingKeys()) {
      settings[key] = {
        value: settingValue(this.config.read(key, target.scope)),
        effective: settingValue(this.config.effective(key)),
        def: settingValue(this.config.defaultValue(key)),
      };
    }
    return { colors, settings };
  }

  /** A null or empty color removes it. */
  setColors(target: Target, changes: Readonly<Record<string, string | null>>): Promise<void> {
    return this.enqueue(() =>
      this.updateObject(COLORS, target, (blk) => {
        for (const [key, value] of Object.entries(changes)) {
          if (value) blk[key] = value;
          else delete blk[key];
        }
      })
    );
  }

  /** A null or empty value removes the setting. */
  setSettings(target: Target, changes: Readonly<Record<string, SettingValue | null>>): Promise<void> {
    return this.enqueue(async () => {
      for (const [key, value] of Object.entries(changes)) {
        await this.config.write(key, value === null || value === '' ? undefined : value, target.scope);
      }
    });
  }

  // ---------- syntax ----------

  syntaxState(target: Target): SyntaxState {
    const items: Record<string, TokenStyle> = {};
    const custom: CustomRule[] = [];
    for (const rule of rulesOf(this.blockAt(TOKENS, target))) {
      const name = nameOf(rule);
      if (!isRecord(rule) || !name?.startsWith(RULE_PREFIX)) continue;
      const s = isRecord(rule.settings) ? rule.settings : {};
      const style: TokenStyle = { fg: str(s.foreground), fontStyle: str(s.fontStyle) };
      if (name.startsWith(CUSTOM_PREFIX)) custom.push({ id: name.slice(CUSTOM_PREFIX.length), scope: scopeList(rule.scope).join(', '), ...style });
      else items[name.slice(RULE_PREFIX.length)] = style;
    }
    const semantic = this.config.effective(SEMANTIC_ENABLED);
    return { items, custom, semanticHighlighting: typeof semantic === 'boolean' ? semantic : null };
  }

  setSyntax(target: Target, changes: readonly SyntaxChange[]): Promise<void> {
    return this.enqueue(async () => {
      const resolved = changes.flatMap((c) => {
        const found = catalog.findItem(c.langId, c.itemId);
        return found ? [{ ...c, ...found }] : [];
      });
      if (!resolved.length) return;

      await this.updateObject(TOKENS, target, (blk) => {
        const names = new Set(resolved.map((c) => ruleName(c.langId, c.itemId)));
        const rules = rulesOf(blk).filter((r) => !names.has(nameOf(r) ?? ''));
        for (const c of resolved) {
          if (!c.style || !hasStyle(c.style) || !c.item.scopes.length) continue;
          rules.push({ name: ruleName(c.langId, c.itemId), scope: catalog.textMateScopes(c.lang, c.item), settings: tmSettings(c.style) });
        }
        setRules(blk, rules);
      });

      if (!resolved.some((c) => c.item.semantic.length)) return;
      await this.updateObject(SEMANTIC, target, (blk) => {
        const rules = isRecord(blk.rules) ? blk.rules : {};
        for (const c of resolved) {
          for (const sel of catalog.semanticSelectors(c.lang, c.item)) {
            if (c.style && hasStyle(c.style)) rules[sel] = semanticStyle(c.style);
            else delete rules[sel];
          }
        }
        setSemanticRules(blk, rules);
      });
    });
  }

  /** Replaces every custom rule with `list`; rules without a scope or a style are left out. */
  setCustom(target: Target, list: readonly CustomRule[]): Promise<void> {
    return this.enqueue(() =>
      this.updateObject(TOKENS, target, (blk) => {
        const rules = rulesOf(blk).filter((r) => !nameOf(r)?.startsWith(CUSTOM_PREFIX));
        for (const c of list) {
          const scope = c.scope
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (!scope.length || !hasStyle(c)) continue;
          rules.push({ name: `${CUSTOM_PREFIX}${c.id}`, scope, settings: tmSettings(c) });
        }
        setRules(blk, rules);
      })
    );
  }

  // ---------- export / import / reset ----------

  exportState(target: Target): Customization {
    const semBlk = this.blockAt(SEMANTIC, target);
    const managed = catalog.allSemanticSelectors();
    const semanticRules: JsonObject = {};
    for (const [sel, value] of Object.entries(isRecord(semBlk.rules) ? semBlk.rules : {})) if (managed.has(sel)) semanticRules[sel] = value;

    const { colors, settings } = this.appearanceState(target);
    const plainSettings: Record<string, SettingValue> = {};
    for (const [key, s] of Object.entries(settings)) if (s.value !== null) plainSettings[key] = s.value;

    return {
      colors,
      settings: plainSettings,
      textMateRules: rulesOf(this.blockAt(TOKENS, target)).filter((r): r is JsonObject => isRecord(r) && !!nameOf(r)?.startsWith(RULE_PREFIX)),
      semanticRules,
    };
  }

  /** Replace: clear what Personify wrote first. Otherwise only add or overwrite what `data` has. */
  importState(target: Target, data: Customization, { replace }: { replace: boolean }): Promise<void> {
    return this.enqueue(async () => {
      await this.updateObject(COLORS, target, (blk) => {
        if (replace) for (const key of catalog.colorKeys()) delete blk[key];
        Object.assign(blk, data.colors);
      });
      const settings: Record<string, SettingValue | undefined> = { ...data.settings };
      if (replace) for (const key of catalog.settingKeys()) if (!(key in settings)) settings[key] = undefined;
      for (const [key, value] of Object.entries(settings)) await this.config.write(key, value, target.scope);

      const incoming = data.textMateRules.filter((r) => nameOf(r)?.startsWith(RULE_PREFIX));
      await this.updateObject(TOKENS, target, (blk) => {
        const drop = new Set(incoming.map(nameOf));
        const rules = rulesOf(blk).filter((r) => {
          const name = nameOf(r);
          return name === null || !(replace ? name.startsWith(RULE_PREFIX) : drop.has(name));
        });
        rules.push(...incoming);
        setRules(blk, rules);
      });
      await this.updateObject(SEMANTIC, target, (blk) => {
        const rules = isRecord(blk.rules) ? blk.rules : {};
        if (replace) for (const sel of catalog.allSemanticSelectors()) delete rules[sel];
        Object.assign(rules, data.semanticRules);
        setSemanticRules(blk, rules);
      });
    });
  }

  resetAll(target: Target): Promise<void> {
    return this.importState(target, EMPTY, { replace: true });
  }

  private static snapshotKeys(): string[] {
    return [COLORS, TOKENS, SEMANTIC, SEMANTIC_ENABLED, ...catalog.settingKeys()];
  }

  snapshot(): Snapshot {
    const snap: Snapshot = { user: {}, workspace: {} };
    for (const scope of SCOPES) for (const key of Customizations.snapshotKeys()) snap[scope][key] = this.readAt(key, scope);
    return snap;
  }

  restoreSnapshot(snap: Snapshot): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of SCOPES) {
        if (scope === 'workspace' && !this.config.canWriteWorkspace()) continue;
        for (const key of Customizations.snapshotKeys()) {
          if (JSON.stringify(this.readAt(key, scope)) !== JSON.stringify(snap[scope][key])) await this.config.write(key, snap[scope][key], scope);
        }
      }
    });
  }
}
