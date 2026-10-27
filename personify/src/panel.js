const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');
const settings = require('./settings');

const WATCHED_KEYS = ['workbench.colorCustomizations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations', 'workbench.colorTheme', settings.SEMANTIC_ENABLED, ...catalog.settingKeys()];

class PersonifyPanel {
  static show(context, store, tab) {
    if (PersonifyPanel.current) {
      PersonifyPanel.current.panel.reveal();
      if (tab) PersonifyPanel.current.post({ type: 'focusTab', tab });
      return;
    }
    PersonifyPanel.current = new PersonifyPanel(context, store, tab);
  }

  constructor(context, store, tab) {
    this.context = context;
    this.store = store;
    this.initialTab = tab;
    this.prefs = context.globalState.get('personify.prefs', { scope: 'user', themeMode: 'all' });
    this.snapshot = settings.snapshot();
    this.keybindingsSnapshot = store.readText();
    this.disposables = [];

    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('personify', 'Personify', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panel.webview.html = this.html(media);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
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

  dispose() {
    PersonifyPanel.current = undefined;
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    this.disposables.forEach((d) => d.dispose());
  }

  watchKeybindings() {
    if (this.watchedFile) fs.unwatchFile(this.watchedFile);
    this.watchedFile = this.store.file;
    fs.watchFile(this.watchedFile, { interval: 1000 }, () => this.schedule('kb', () => this.pushKeybindings()));
  }

  schedule(name, fn, delay = 150) {
    this.timers = this.timers || {};
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(fn, delay);
  }

  post(msg) {
    return this.panel.webview.postMessage(msg);
  }

  toast(text, kind = 'info') {
    this.post({ type: 'toast', text, kind });
  }

  get ctx() {
    const theme = vscode.workspace.getConfiguration('workbench').get('colorTheme');
    return { scope: this.prefs.scope, theme: this.prefs.themeMode === 'current' ? theme : null };
  }

  pushState() {
    const theme = vscode.workspace.getConfiguration('workbench').get('colorTheme');
    const hasWorkspace = Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
    if (!hasWorkspace && this.prefs.scope === 'workspace') this.prefs.scope = 'user';
    const ctx = this.ctx;
    this.post({
      type: 'state',
      prefs: { ...this.prefs, theme, hasWorkspace },
      appearance: settings.appearanceState(ctx),
      syntax: settings.syntaxState(ctx),
    });
  }

  async pushKeybindings(force) {
    try {
      this.post({ type: 'keybindings', ...(await this.store.state(force)) });
    } catch (e) {
      this.toast(`Could not load keybindings: ${e.message}`, 'error');
    }
  }

  async onMessage(msg) {
    try {
      await this.handle(msg);
    } catch (e) {
      this.toast(e.message || String(e), 'error');
      if (msg.type === 'kb') this.pushKeybindings();
      else this.pushState();
    }
  }

  async handle(msg) {
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
        await this.context.globalState.update('personify.prefs', this.prefs);
        this.pushState();
        return;
      case 'setColors':
        return settings.setColors(this.ctx, msg.changes);
      case 'setSettings':
        return settings.setSettings(this.ctx, msg.changes);
      case 'setSyntax':
        return settings.setSyntax(this.ctx, msg.changes);
      case 'setCustom':
        return settings.setCustom(this.ctx, msg.list);
      case 'kb':
        this.store[msg.op](msg.payload);
        await this.pushKeybindings();
        return;
      case 'kbRefresh':
        return this.pushKeybindings(true);
      case 'openKeybindingsJson':
        return vscode.window.showTextDocument(vscode.Uri.file(this.store.file), { viewColumn: vscode.ViewColumn.Beside });
      case 'openSettingsJson':
        return vscode.commands.executeCommand(this.prefs.scope === 'workspace' ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson');
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
    }
  }

  async openSample(langId) {
    const lang = catalog.LANGUAGES.find((l) => l.id === langId);
    if (!lang) return;
    const doc = await vscode.workspace.openTextDocument({ language: lang.sampleLanguage, content: catalog.sampleText(lang) });
    return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  // The scope inspector works on a text editor, so focus one (or open the sample) first.
  async inspectScope(langId) {
    const editor = vscode.window.visibleTextEditors[0];
    if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    else await this.openSample(langId);
    await vscode.commands.executeCommand('editor.action.inspectTMScopes');
  }

  async exportFile(includeKeybindings) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'personify-profile.json')),
      filters: { 'Personify profile': ['json'] },
    });
    if (!uri) return;
    const data = { personify: 1, exportedAt: new Date().toISOString(), ...settings.exportState(this.ctx) };
    if (includeKeybindings) data.keybindings = this.store.read().list;
    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2));
    this.toast(`Exported to ${uri.fsPath}`, 'success');
  }

  async importFile() {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Personify profile': ['json'] } })) || [];
    if (!uri) return;
    const data = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
    if (!data || data.personify !== 1) throw new Error('This file is not a Personify profile.');
    const mode = await vscode.window.showInformationMessage(
      'Import Personify profile',
      { modal: true, detail: 'Replace: clear current Personify customizations first.\nMerge: only add/overwrite what the file contains.' },
      'Replace',
      'Merge'
    );
    if (!mode) return;
    await settings.importState(this.ctx, data, { replace: mode === 'Replace' });

    if (Array.isArray(data.keybindings) && data.keybindings.length) {
      const ok = await vscode.window.showInformationMessage(`The profile also has ${data.keybindings.length} keybindings. Add the missing ones to your keybindings.json?`, { modal: true }, 'Add');
      if (ok) {
        const existing = new Set(this.store.read().list.map((k) => JSON.stringify(k)));
        for (const kb of data.keybindings) if (kb && kb.command && !existing.has(JSON.stringify(kb))) this.store.add(kb);
        await this.pushKeybindings();
      }
    }
    this.toast('Profile imported', 'success');
  }

  async resetAll() {
    const where = this.prefs.scope === 'workspace' ? 'workspace' : 'user';
    const theme = this.ctx.theme ? ` for theme "${this.ctx.theme}"` : '';
    const ok = await vscode.window.showWarningMessage(
      `Remove every Personify color, font and syntax customization from ${where} settings${theme}?`,
      { modal: true, detail: 'Keybindings are not touched. Settings you wrote by hand outside Personify are kept.' },
      'Reset'
    );
    if (!ok) return;
    await settings.resetAll(this.ctx);
    this.toast('Personify customizations removed', 'success');
  }

  async revertSession() {
    const ok = await vscode.window.showWarningMessage(
      'Undo everything changed since this Personify panel was opened?',
      { modal: true, detail: 'Restores colors, fonts, syntax colors (user and workspace) and keybindings.json.' },
      'Revert'
    );
    if (!ok) return;
    await settings.restoreSnapshot(this.snapshot);
    if (this.store.readText() !== this.keybindingsSnapshot) this.store.writeText(this.keybindingsSnapshot);
    await this.pushKeybindings();
    this.toast('Reverted to the state when the panel was opened', 'success');
  }

  html(media) {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
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

module.exports = { PersonifyPanel };
