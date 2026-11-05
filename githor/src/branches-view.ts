import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { AccountProblem, activePick } from './account-git';
import { accountsView, addAccount, signInAgain, useAccount } from './account-ui';
import type { AccountStore } from './account-store';
import { parseRemote, ruleAccount } from './core/accounts';
import type { AccountId } from './core/types';
import { gitUri } from './git-content';
import { parseClientMessage } from './protocol';
import type { Actions } from './actions';
import type { RepoModel } from './model';
import type { ClientMessage, HostMessage } from './protocol';

/** The `sha` the page uses for the working copy. */
const WORKTREE = 'WORKTREE';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Where a page sits: the sidebar shows the compact layout (design `05`), the editor tab the full one (`01`). */
export type Place = 'editor' | 'sidebar';

export interface BranchesViewArgs {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  model: RepoModel;
  actions: Actions;
  accounts: AccountStore;
  place: Place;
}

/** The Githor page in one webview: renders the model's state and runs what the page asks for. */
export class BranchesView implements vscode.Disposable {
  private ready = false;
  /** Messages for the page that arrived before it was up. */
  private readonly queued: HostMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webview: vscode.Webview;
  private readonly model: RepoModel;
  private readonly actions: Actions;
  private readonly place: Place;
  private readonly accounts: AccountStore;
  /** What the remote or the commit check stopped, to run again after the person picks an account (design `48`). */
  private pending: ClientMessage | null = null;
  /** The page asked for the accounts page once: it gets it again when accounts change. */
  private accountsShown = false;

  constructor({ webview, extensionUri, model, actions, accounts, place }: BranchesViewArgs) {
    this.place = place;
    this.accounts = accounts;
    this.webview = webview;
    this.model = model;
    this.actions = actions;
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const scripts = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [media, scripts] };
    webview.html = this.html({ media, scripts, place });
    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseClientMessage(raw);
        if (message) void this.handle(message).catch((e: unknown) => this.failed(e, message));
      }),
      model.onDidChange(() => this.sendState()),
      accounts.onDidChange(() => {
        this.sendState();
        if (this.accountsShown) void this.sendAccounts();
      }),
      model.onDidFail((text) => this.post({ type: 'error', text }))
    );
  }

  /** Sends `message` to the page now, or as soon as it is up. */
  request(message: HostMessage): void {
    if (this.ready) this.post(message);
    else this.queued.push(message);
  }

  private post(message: HostMessage): void {
    void this.webview.postMessage(message);
  }

  private async toast(outcome: Promise<{ text: string; undo: number | null }>): Promise<void> {
    const { text, undo } = await outcome;
    this.post({ type: 'toast', text, undo });
  }

  /** An operation that may pause at a conflict: a toast only when it finished. */
  private async toastIf(outcome: Promise<{ text: string; undo: number | null } | null>): Promise<void> {
    const done = await outcome;
    if (done) this.post({ type: 'toast', text: done.text, undo: done.undo });
  }

  /** A dialog's action: on success the dialog closes and the toast says what happened. */
  private async toastAndClose(outcome: Promise<{ text: string; undo: number | null }>): Promise<void> {
    const { text, undo } = await outcome;
    this.post({ type: 'branchDone' });
    this.post({ type: 'toast', text, undo });
  }

  /** A changed file side by side in VS Code's diff editor: before on the left, the commit on the right. */
  private async openDiff({ sha, parent, file }: Extract<ClientMessage, { type: 'openDiff' }>): Promise<void> {
    const root = this.model.root;
    if (!root) return;
    const left = gitUri({ root, ref: file.status === 'A' ? null : parent, path: file.oldPath ?? file.path });
    // the working copy opens as the file itself, so it can be edited right there
    const right = sha === WORKTREE ? vscode.Uri.file(path.join(root, file.path)) : gitUri({ root, ref: file.status === 'D' ? null : sha, path: file.path });
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path} (${sha.slice(0, 7)})`, { preview: true });
  }

  /** A refusal by the remote is an account's problem the page explains (design `48`); anything else is an error. */
  private failed(e: unknown, message: ClientMessage): void {
    if (e instanceof AccountProblem) {
      this.pending = message;
      const ref = (a: { id: AccountId; label: string }): { id: AccountId; label: string } => ({ id: a.id, label: a.label });
      this.post({ type: 'accountProblem', kind: e.kind, account: ref(e.account), remoteName: this.model.remote?.name ?? 'The remote', remote: e.remote, suggestion: e.suggestion && ref(e.suggestion) });
      return;
    }
    this.post({ type: 'error', text: errorText(e) });
  }

  private sendState(): void {
    if (!this.ready) return;
    const { account } = activePick({ store: this.accounts, model: this.model });
    const accountState = account ? { id: account.id, label: account.label, email: account.email, expired: this.accounts.expired().has(account.id) } : null;
    this.post({ type: 'state', state: { ...this.model.state(), account: accountState, hasAccounts: this.accounts.list().length > 0 } });
  }

  private async sendAccounts(): Promise<void> {
    this.post({ type: 'accounts', view: await accountsView({ store: this.accounts, model: this.model }) });
  }

  private async handle(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // Sent again each time a hidden sidebar view is shown, because VS Code reloads its page.
        this.ready = true;
        this.sendState();
        for (const m of this.queued.splice(0)) this.post(m);
        if (!this.model.loaded) await this.model.refresh();
        return;
      case 'fetch':
        return this.actions.fetch({ all: message.all });
      case 'switch':
        return this.actions.switchTo(message.ref);
      case 'pickBranch':
        await vscode.commands.executeCommand('githor.switchBranch');
        return;
      case 'openEditor':
        await vscode.commands.executeCommand('githor.open');
        return;
      case 'showOutput':
        await vscode.commands.executeCommand('githor.showOutput');
        return;
      case 'scanMerged':
        this.post({ type: 'merged', view: await this.actions.scanMerged(message.target) });
        return;
      case 'deleteMerged': {
        const outcome = await this.actions.deleteMerged(message);
        this.post({ type: 'mergedDone' });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'push':
        return this.toast(this.actions.push(message));
      case 'pull':
        return this.toast(this.actions.pull(message.ref));
      case 'publish':
        return this.toast(this.actions.publish(message.ref));
      case 'sync':
        return this.toast(this.actions.sync(message.ref ?? undefined));
      case 'checkName':
        this.post({ type: 'nameCheck', name: message.name, problem: await this.actions.checkName(message.name) });
        return;
      case 'newBranch':
        await this.toastAndClose(this.actions.newBranch(message));
        return;
      case 'rename':
        await this.toastAndClose(this.actions.rename(message));
        return;
      case 'deleteInfo':
        this.post({ type: 'deleteInfo', ref: message.ref, ...(await this.actions.deleteInfo(message.ref)) });
        return;
      case 'deleteBranch':
        await this.toastAndClose(this.actions.deleteBranch(message));
        return;
      case 'pin':
        return this.actions.pin(message.ref, message.pinned);
      case 'log':
        this.post({ type: 'log', ...(await this.actions.commitLog(message.limit)) });
        return;
      case 'commitDetails':
        this.post({ type: 'commitDetails', details: await this.actions.commitDetails(message.shas) });
        return;
      case 'switchCommit':
        return this.toast(this.actions.switchCommit(message.sha));
      case 'cherryPick':
        return this.toast(this.actions.cherryPick(message.shas));
      case 'revert':
        return this.toast(this.actions.revert(message.sha));
      case 'openDiff':
        return this.openDiff(message);
      case 'fileDiff':
        this.post({ type: 'fileDiff', diff: await this.actions.fileDiff(message) });
        return;
      case 'workingDiff':
        this.post({ type: 'fileDiff', diff: await this.actions.workingDiff(message.path) });
        return;
      case 'setGrouping':
        return this.model.setGrouping(message.grouping);
      case 'commit': {
        // the account differs from what the rules pick for this remote: ask first (design `48`)
        const pick = activePick({ store: this.accounts, model: this.model });
        const remote = this.model.remote ? parseRemote(this.model.remote.url) : null;
        const byRule = ruleAccount({ accounts: this.accounts.list(), rules: this.accounts.rules(), remote });
        if (!message.confirmedAccount && pick.account && byRule && pick.why !== 'rule' && byRule.account.id !== pick.account.id) {
          this.pending = { ...message, confirmedAccount: true };
          this.post({ type: 'confirmAccount', active: { id: pick.account.id, label: pick.account.label }, suggested: { id: byRule.account.id, label: byRule.account.label }, rule: byRule.rule.remote });
          return;
        }
        const outcome = await this.actions.commit(message);
        this.post({ type: 'committed', push: message.push, ref: this.model.current?.ref ?? null });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'compare':
        // the sidebar has no room for it: the editor tab opens on the compare screen
        if (this.place === 'sidebar') await vscode.commands.executeCommand('githor.compare', message.ref);
        else this.post({ type: 'compare', view: await this.actions.compare(message.ref) });
        return;
      case 'bringTogether':
        return this.toastIf(this.actions.bringTogether(message));
      case 'conflictFile':
        this.post({ type: 'conflictFile', path: message.path, parts: await this.actions.conflictFile(message.path) });
        return;
      case 'resolveConflict':
        return this.actions.resolveConflict(message);
      case 'reopenConflict':
        return this.actions.reopenConflict(message.path);
      case 'continueOperation':
        return this.toastIf(this.actions.continueOperation());
      case 'abortOperation':
        return this.toast(this.actions.abortOperation());
      case 'accounts':
        this.accountsShown = true;
        return this.sendAccounts();
      case 'addAccount': {
        const added = await addAccount({ store: this.accounts, input: message.input });
        this.post({ type: 'accountDone' });
        if (added) this.post({ type: 'toast', text: `Added ${added.label}`, undo: null });
        return this.sendAccounts();
      }
      case 'editAccount': {
        const account = this.accounts.list().find((a) => a.id === message.id);
        if (account) await this.accounts.save({ ...account, label: message.label.trim(), name: message.name.trim(), email: message.email.trim() }, null);
        this.post({ type: 'accountDone' });
        return this.sendAccounts();
      }
      case 'removeAccount': {
        const account = this.accounts.list().find((a) => a.id === message.id);
        await this.accounts.remove(message.id as AccountId);
        this.post({ type: 'accountDone' });
        if (account) this.post({ type: 'toast', text: `Removed ${account.label}`, undo: null });
        return this.sendAccounts();
      }
      case 'useAccount': {
        const { text, undo } = await useAccount({ store: this.accounts, model: this.model, id: message.id as AccountId | null });
        this.post({ type: 'toast', text, undo: this.actions.remember(undo) });
        return this.sendAccounts();
      }
      case 'signInAgain': {
        const signedIn = await signInAgain({ store: this.accounts, id: message.id as AccountId });
        await this.sendAccounts();
        if (!signedIn) return;
        // a sign-in asked for by a refusal runs what was refused again
        if (this.pending) return this.handle({ type: 'retryAs', id: null });
        this.post({ type: 'toast', text: 'Signed in again', undo: null });
        return;
      }
      case 'retryAs': {
        const again = this.pending;
        this.pending = null;
        if (message.id) {
          const { text, undo } = await useAccount({ store: this.accounts, model: this.model, id: message.id as AccountId });
          this.post({ type: 'toast', text, undo: this.actions.remember(undo) });
        }
        // a second refusal opens its own dialog, for the message that was refused
        if (again) await this.handle(again).catch((e: unknown) => this.failed(e, again));
        return;
      }
      case 'dropRetry':
        this.pending = null;
        return;
      case 'openRules':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'githor.accounts.rules');
        return;
      case 'stashes':
        this.post({ type: 'stashes', stashes: await this.actions.stashes() });
        return;
      case 'stashDiff':
        this.post({ type: 'fileDiff', diff: await this.actions.stashDiff(message) });
        return;
      case 'stashPush': {
        const outcome = await this.actions.stashPush(message);
        this.post({ type: 'stashDone' });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'stashApply':
        return this.toast(this.actions.stashApply(message.sha));
      case 'stashDrop':
        return this.toast(this.actions.stashDrop(message.sha));
      case 'stashRename': {
        const outcome = await this.actions.stashRename(message);
        this.post({ type: 'stashDone' });
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'squashPlan':
        this.post({ type: 'squashPlan', shas: message.shas, plan: await this.actions.squashPlan(message.shas) });
        return;
      case 'squash': {
        const outcome = await this.actions.squash(message);
        this.post({ type: 'squashDone' });
        if (outcome) this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      case 'pushReview':
        this.post({ type: 'pushReview', ref: message.ref, ...(await this.actions.pushReview(message.ref)) });
        return;
      case 'copyName':
        await vscode.env.clipboard.writeText(message.name);
        this.post({ type: 'toast', text: `Copied ${message.name}`, undo: null });
        return;
      case 'forceInfo':
        this.post({ type: 'forceInfo', ref: message.ref, ...(await this.actions.forceInfo(message.ref)) });
        return;
      case 'undo': {
        const outcome = await this.actions.undo(message.id);
        this.post({ type: 'toast', text: outcome.text, undo: outcome.undo });
        return;
      }
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  private html({ media, scripts, place }: { media: vscode.Uri; scripts: vscode.Uri; place: Place }): string {
    const webview = this.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(scripts, 'media', 'main.js'));
    // The page is ES modules: the entry is allowed by its nonce, the modules it imports by their origin.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${css}">
  <title>Githor</title>
</head>
<body class="gt-scope gt-in-${place}" data-place="${place}">
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
