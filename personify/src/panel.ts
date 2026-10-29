import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as catalog from './catalog';
import { Customizations, SEMANTIC_ENABLED } from './core/customizations';
import { str } from './core/json';
import { parseProfile, profileFile } from './core/profile';
import { parseClientMessage, parsePrefs } from './protocol';
import { vscodeConfig } from './settings';
import type { KeybindingStore } from './keybindings';
import type { Snapshot } from './core/customizations';
import type { Prefs, Tab, Target } from './core/types';
import type { ClientMessage, HostMessage, ToastKind } from './protocol';

const PREFS_KEY = 'personify.prefs';
const WATCHED_KEYS = ['workbench.colorCustomizations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations', 'workbench.colorTheme', SEMANTIC_ENABLED, ...catalog.settingKeys()];

const activeTheme = (): string => str(vscode.workspace.getConfiguration('workbench').get<unknown>('colorTheme')) ?? '';
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class PersonifyPanel {
  private static current: PersonifyPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly customizations = new Customizations(vscodeConfig);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private prefs: Prefs;
  /** What both levels of settings held when the panel opened, for Revert session. */
  private readonly snapshot: Snapshot;
  private readonly keybindingsSnapshot: Promise<string>;
  private watchedFile: string | undefined;

  static show(context: vscode.ExtensionContext, store: KeybindingStore, tab?: Tab): void {
    if (PersonifyPanel.current) {
      PersonifyPanel.current.panel.reveal();
      if (tab) PersonifyPanel.current.post({ type: 'focusTab', tab });
      return;
    }
    PersonifyPanel.current = new PersonifyPanel(context, store, tab ?? null);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: KeybindingStore,
    private readonly initialTab: Tab | null
  ) {
    this.prefs = parsePrefs(context.globalState.get<unknown>(PREFS_KEY));
    this.snapshot = this.customizations.snapshot();
    this.keybindingsSnapshot = store.readText();

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
        if (e.affectsConfiguration('personify.keybindingsPath')) this.watchKeybindings();
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
  }

  // fs.watchFile polls, so it also notices a keybindings.json that does not exist yet. It runs only while the panel is open.
  private watchKeybindings(): void {
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    this.watchedFile = this.store.file;
    fs.watchFile(this.watchedFile, { interval: 1000 }, () => this.schedule('kb', () => void this.pushKeybindings()));
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
      case 'setSyntax':
        return this.customizations.setSyntax(this.target, msg.changes);
      case 'setCustom':
        return this.customizations.setCustom(this.target, msg.list);
      case 'kb':
        await this.store.apply(msg.edit);
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
      case 'resetAll':
        return this.resetAll();
      case 'revertSession':
        return this.revertSession();
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
    const keybindings = includeKeybindings ? (await this.store.read()).list : null;
    const data = profileFile(this.customizations.exportState(this.target), keybindings, new Date());
    await fs.promises.writeFile(uri.fsPath, JSON.stringify(data, null, 2));
    this.toast(`Exported to ${uri.fsPath}`, 'success');
  }

  private async importFile(): Promise<void> {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Personify profile': ['json'] } })) ?? [];
    if (!uri) return;
    const data = parseProfile(JSON.parse(await fs.promises.readFile(uri.fsPath, 'utf8')));
    if (!data) throw new Error('This file is not a Personify profile.');
    const mode = await vscode.window.showInformationMessage(
      'Import Personify profile',
      { modal: true, detail: 'Replace: clear current Personify customizations first.\nMerge: only add/overwrite what the file contains.' },
      'Replace',
      'Merge'
    );
    if (!mode) return;
    await this.customizations.importState(this.target, data, { replace: mode === 'Replace' });

    if (data.keybindings.length) {
      const ok = await vscode.window.showInformationMessage(`The profile also has ${data.keybindings.length} keybindings. Add the missing ones to your keybindings.json?`, { modal: true }, 'Add');
      if (ok) {
        const existing = new Set((await this.store.read()).list.map((k) => JSON.stringify(k)));
        for (const kb of data.keybindings) {
          if (existing.has(JSON.stringify(kb))) continue;
          await this.store.apply({ op: 'add', command: str(kb.command) ?? '', key: str(kb.key) ?? '', when: str(kb.when) ?? '', args: kb.args });
        }
        await this.pushKeybindings();
      }
    }
    this.toast('Profile imported', 'success');
  }

  private async resetAll(): Promise<void> {
    const where = this.prefs.scope === 'workspace' ? 'workspace' : 'user';
    const theme = this.target.theme ? ` for theme "${this.target.theme}"` : '';
    const ok = await vscode.window.showWarningMessage(
      `Remove every Personify color, font and syntax customization from ${where} settings${theme}?`,
      { modal: true, detail: 'Keybindings are not touched. Settings you wrote by hand outside Personify are kept.' },
      'Reset'
    );
    if (!ok) return;
    await this.customizations.resetAll(this.target);
    this.toast('Personify customizations removed', 'success');
  }

  private async revertSession(): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      'Undo everything changed since this Personify panel was opened?',
      { modal: true, detail: 'Restores colors, fonts, syntax colors (user and workspace) and keybindings.json.' },
      'Revert'
    );
    if (!ok) return;
    await this.customizations.restoreSnapshot(this.snapshot);
    const keybindings = await this.keybindingsSnapshot;
    if ((await this.store.readText()) !== keybindings) await this.store.writeText(keybindings);
    await this.pushKeybindings();
    this.toast('Reverted to the state when the panel was opened', 'success');
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
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
