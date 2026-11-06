import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as catalog from './catalog';
import { Customizations, RULE_PREFIX, SEMANTIC_ENABLED, TOKENS } from './core/customizations';
import { errorMessage, str } from './core/json';
import { diffProfile, parseProfile, profileFile } from './core/profile';
import { parseSnapshots, snapshotInfo, withSnapshot } from './core/snapshots';
import { customizationRules, itemStyles } from './core/themeSyntax';
import { parseClientMessage, parsePrefs } from './protocol';
import { vscodeConfig } from './settings';
import { ThemeReader } from './themes';
import type { KeybindingStore } from './keybindings';
import type { Snapshot } from './core/customizations';
import type { Profile } from './core/profile';
import type { SnapshotId, SnapshotRecord } from './core/snapshots';
import type { Prefs, Tab, Target } from './core/types';
import type { ClientMessage, HostMessage, ToastKind } from './protocol';

const PREFS_KEY = 'personify.prefs';
const SNAPSHOTS_KEY = 'personify.snapshots';
// What the theme's syntax colors depend on.
const THEME_KEYS = ['workbench.colorTheme', 'editor.tokenColorCustomizations', SEMANTIC_ENABLED];
const WATCHED_KEYS = ['workbench.colorCustomizations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations', 'workbench.colorTheme', SEMANTIC_ENABLED, ...catalog.SETTING_KEYS];

const activeTheme = (): string => str(vscode.workspace.getConfiguration('workbench').get<unknown>('colorTheme')) ?? '';

export class PersonifyPanel {
  private static current: PersonifyPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly customizations = new Customizations(vscodeConfig);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private prefs: Prefs;
  /** What both levels of settings held when the panel opened, for Revert session. */
  private readonly snapshot: Snapshot;
  /** keybindings.json when the panel opened; null when it could not be read. */
  private readonly keybindingsSnapshot: Promise<{ file: string; text: string } | null>;
  private watchedFile: string | undefined;
  /** When the panel opened: Revert session goes back to it. */
  private readonly sessionStart = Date.now();
  /** The profile last previewed, until the panel applies or cancels it. */
  private pendingImport: { file: string; data: Profile } | null = null;
  private readonly themes = new ThemeReader();
  /** The theme syntax colors last sent, so an unrelated settings change does not resend them. */
  private lastThemeSyntax = '';

  static show(context: vscode.ExtensionContext, store: KeybindingStore, tab?: Tab): void {
    if (PersonifyPanel.current) {
      PersonifyPanel.current.panel.reveal();
      if (tab) PersonifyPanel.current.post({ type: 'focusTab', tab });
      return;
    }
    PersonifyPanel.current = new PersonifyPanel(context, store, tab ?? null);
  }

  /** Closes the open panel, if any; `activate` owns this, so nothing outlives the extension. */
  static readonly owner: vscode.Disposable = { dispose: () => PersonifyPanel.current?.panel.dispose() };

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: KeybindingStore,
    private readonly initialTab: Tab | null
  ) {
    this.prefs = parsePrefs(context.globalState.get<unknown>(PREFS_KEY));
    this.snapshot = this.customizations.snapshot();
    const file = store.file;
    this.keybindingsSnapshot = store.disk.readText(file).then(
      (text) => ({ file, text }),
      () => null
    );

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    this.panel = vscode.window.createWebviewPanel('personify', 'Personify', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media, scripts],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panel.webview.html = this.html(media, scripts);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (WATCHED_KEYS.some((k) => e.affectsConfiguration(k))) this.schedule('state', () => this.pushState());
        if (THEME_KEYS.some((k) => e.affectsConfiguration(k))) this.schedule('theme', () => void this.pushThemeSyntax());
        if (e.affectsConfiguration('personify.keybindingsPath')) {
          this.watchKeybindings();
          void this.pushKeybindings();
        }
      },
      null,
      this.disposables
    );
    this.watchKeybindings();
  }

  private dispose(): void {
    PersonifyPanel.current = undefined;
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
    this.themes.dispose();
  }

  // fs.watchFile polls, so it also notices a keybindings.json that does not exist yet. It runs only while the panel is open.
  private watchKeybindings(): void {
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    this.watchedFile = this.store.file;
    fs.watchFile(this.watchedFile, { interval: 1000 }, () => this.schedule('kb', () => void this.pushIfChanged()));
  }

  // The watcher also sees Personify's own writes, whose state is already pushed.
  private async pushIfChanged(): Promise<void> {
    if (!(await this.store.showsCurrentFile())) await this.pushKeybindings();
  }

  private schedule(name: string, fn: () => void, delay = 150): void {
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(fn, delay));
  }

  private post(msg: HostMessage): void {
    void this.panel.webview.postMessage(msg);
  }

  private toast(text: string, kind: ToastKind = 'info'): void {
    this.post({ type: 'toast', text, kind });
  }

  private get target(): Target {
    return { scope: this.prefs.scope, theme: this.prefs.themeMode === 'current' ? activeTheme() || null : null };
  }

  private pushState(): void {
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
    if (!hasWorkspace && this.prefs.scope === 'workspace') this.prefs = { ...this.prefs, scope: 'user' };
    const target = this.target;
    this.post({
      type: 'state',
      prefs: { ...this.prefs, theme: activeTheme(), hasWorkspace },
      appearance: this.customizations.appearanceState(target),
      syntax: this.customizations.syntaxState(target),
    });
  }

  /** The theme's syntax colors with the user's own token colors on top, for the panel's code samples. */
  private async pushThemeSyntax(): Promise<void> {
    const theme = activeTheme();
    const { tokens, problem } = await this.themes.read(theme);
    const extra = customizationRules(vscodeConfig.effective(TOKENS), theme, (name) => name.startsWith(RULE_PREFIX));
    // true and false decide; anything else ("configuredByTheme") leaves it to the theme.
    const setting = vscodeConfig.effective(SEMANTIC_ENABLED);
    const semantic = typeof setting === 'boolean' ? setting : tokens.semanticHighlighting;
    const items = itemStyles({ tokens, extra, languages: catalog.LANGUAGES, semantic });
    const sent = JSON.stringify([theme, items, problem]);
    if (sent === this.lastThemeSyntax) return;
    this.lastThemeSyntax = sent;
    this.post({ type: 'themeSyntax', theme, items, problem });
  }

  private async pushKeybindings(force = false): Promise<void> {
    try {
      this.post({ type: 'keybindings', ...(await this.store.state(force)) });
    } catch (e) {
      this.toast(`Could not load keybindings: ${errorMessage(e)}`, 'error');
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) return;
    try {
      await this.handle(msg);
    } catch (e) {
      this.toast(errorMessage(e), 'error');
      if (msg.type === 'kb') await this.pushKeybindings();
      else this.pushState();
    }
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({
          type: 'init',
          tab: this.initialTab,
          platform: process.platform,
          catalog: { areas: catalog.AREAS, languages: catalog.LANGUAGES },
        });
        this.pushState();
        this.pushSnapshots();
        await this.pushThemeSyntax();
        await this.pushKeybindings();
        return;
      case 'prefs':
        this.prefs = { scope: msg.scope, themeMode: msg.themeMode };
        await this.context.globalState.update(PREFS_KEY, this.prefs);
        this.pushState();
        return;
      case 'setColors':
        return this.customizations.setColors(this.target, msg.changes);
      case 'setSettings':
        return this.customizations.setSettings(this.target, msg.changes);
      case 'setSemanticHighlighting':
        return this.customizations.setSemanticHighlighting(this.target, msg.value);
      case 'setSyntax':
        return this.customizations.setSyntax(this.target, msg.changes);
      case 'setCustom':
        return this.customizations.setCustom(this.target, msg.list);
      case 'kb':
        await this.store.apply(msg.edit);
        this.toast('Saved to keybindings.json', 'success');
        await this.pushKeybindings();
        return;
      case 'kbRefresh':
        return this.pushKeybindings(true);
      case 'openKeybindingsJson':
        await vscode.window.showTextDocument(vscode.Uri.file(this.store.file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      case 'openSettingsJson':
        await vscode.commands.executeCommand(this.prefs.scope === 'workspace' ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
        return;
      case 'openSample':
        return this.openSample(msg.langId);
      case 'inspectScope':
        return this.inspectScope(msg.langId);
      case 'export':
        return this.exportFile(msg.includeKeybindings);
      case 'import':
        return this.importFile();
      case 'importApply':
        return this.applyImport(msg.replace, msg.keybindings);
      case 'importCancel':
        this.pendingImport = null;
        return;
      case 'resetAll':
        return this.resetAll();
      case 'revertSession':
        return this.revertSession();
      case 'restoreSnapshot':
        return this.restore(msg.id);
      default: {
        const unknownMessage: never = msg;
        return unknownMessage;
      }
    }
  }

  private async openSample(langId: string): Promise<void> {
    const lang = catalog.LANGUAGES.find((l) => l.id === langId);
    if (!lang) return;
    const doc = await vscode.workspace.openTextDocument({ language: lang.sampleLanguage, content: catalog.sampleText(lang) });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  // The scope inspector works on a text editor, so focus one (or open the sample) first.
  private async inspectScope(langId: string): Promise<void> {
    const editor = vscode.window.visibleTextEditors[0];
    if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    else await this.openSample(langId);
    await vscode.commands.executeCommand('editor.action.inspectTMScopes');
  }

  private async exportFile(includeKeybindings: boolean): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'personify-profile.json')),
      filters: { 'Personify profile': ['json'] },
    });
    if (!uri) return;
    const keybindings = includeKeybindings ? (await this.store.disk.read()).list : null;
    const data = profileFile(this.customizations.exportState(this.target), keybindings, new Date());
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    this.toast(`Exported to ${uri.scheme === 'file' ? uri.fsPath : uri.toString()}`, 'success');
  }

  /** Reads the profile and sends the panel what it would change; nothing is written until the panel confirms. */
  private async importFile(): Promise<void> {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Personify profile': ['json'] } })) ?? [];
    if (!uri) return;
    const data = parseProfile(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))));
    if (!data) throw new Error('This file is not a Personify profile.');
    const file = path.basename(uri.path);
    this.pendingImport = { file, data };
    const current = this.customizations.exportState(this.target);
    this.post({
      type: 'importPreview',
      preview: {
        file,
        merge: diffProfile(current, data, { replace: false }),
        replace: diffProfile(current, data, { replace: true }),
        keybindings: data.keybindings.slice(0, 15).map((kb) => `${str(kb.key) ?? ''} → ${str(kb.command) ?? ''}${kb.args === undefined ? '' : ' (with args)'}`),
        keybindingCount: data.keybindings.length,
      },
    });
  }

  private async applyImport(replace: boolean, withKeybindings: boolean): Promise<void> {
    const pending = this.pendingImport;
    this.pendingImport = null;
    if (!pending) return;
    await this.takeSnapshot(`Before importing ${pending.file}`);
    await this.customizations.importState(this.target, pending.data, { replace });
    if (withKeybindings && pending.data.keybindings.length) {
      const added = await this.store.addMissing(pending.data.keybindings);
      this.toast(added ? `Added ${added} shortcut${added > 1 ? 's' : ''}` : 'Every shortcut was already there');
      await this.pushKeybindings();
    }
    this.toast(`Imported ${pending.file}. Undo it from Snapshots.`, 'success');
  }

  private async resetAll(): Promise<void> {
    await this.takeSnapshot('Before resetting Personify customizations');
    await this.customizations.resetAll(this.target);
    this.toast('Personify customizations removed. Undo it from Snapshots.', 'success');
  }

  private async revertSession(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      'Undo everything changed since this Personify panel was opened?',
      { modal: true, detail: 'Restores colors, fonts, syntax colors (user and workspace) and keybindings.json. A snapshot is taken first.' },
      'Revert'
    );
    if (!ok) return;
    await this.takeSnapshot('Before reverting the session');
    await this.customizations.restoreSnapshot(this.snapshot);
    const keybindings = await this.keybindingsSnapshot;
    if (keybindings) await this.store.disk.restore(keybindings.file, keybindings.text);
    await this.pushKeybindings();
    this.toast('Reverted to the state when the panel was opened', 'success');
  }

  // ---------- snapshots ----------

  private snapshots(): SnapshotRecord[] {
    return parseSnapshots(this.context.globalState.get<unknown>(SNAPSHOTS_KEY));
  }

  private pushSnapshots(): void {
    this.post({ type: 'snapshots', list: snapshotInfo(this.snapshots()), sessionStart: this.sessionStart });
  }

  /** Saves both levels of settings and keybindings.json, so what comes next can be undone. */
  private async takeSnapshot(reason: string): Promise<void> {
    const file = this.store.file;
    const keybindings = await this.store.disk.readText(file).then(
      (text) => ({ file, text }),
      () => null
    );
    const record: SnapshotRecord = { id: crypto.randomUUID() as SnapshotId, at: Date.now(), reason, settings: this.customizations.snapshot(), keybindings };
    await this.context.globalState.update(SNAPSHOTS_KEY, withSnapshot(this.snapshots(), record));
    this.pushSnapshots();
  }

  private async restore(id: SnapshotId): Promise<void> {
    const snap = this.snapshots().find((s) => s.id === id);
    if (!snap) throw new Error('That snapshot is gone.');
    await this.takeSnapshot('Before restoring a snapshot');
    await this.customizations.restoreSnapshot(snap.settings);
    if (snap.keybindings) await this.store.disk.restore(snap.keybindings.file, snap.keybindings.text);
    await this.pushKeybindings();
    this.toast('Snapshot restored', 'success');
  }

  private html(media: vscode.Uri, scripts: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Personify</title>
</head>
<body>
  <div id="app"></div>
  <div id="toasts"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
