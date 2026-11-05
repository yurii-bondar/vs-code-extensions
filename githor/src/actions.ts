import * as vscode from 'vscode';
import { switchBranch } from './core/branches';
import { deleteBranches, restoreBranches } from './core/cleanup';
import { mergeTargets, scanMerged } from './core/merged';
import { fetchRemotes } from './core/remote';
import { publish, pull, push, remoteOnlyCommits } from './core/sync';
import { cannotPull, cannotPush } from './core/sync-rules';
import type { Branch, DeletedBranch, MergedBranch, RepoRoot } from './core/types';
import type { RepoModel } from './model';
import type { BusyView, MergedView } from './protocol';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}es`): string => `${n} ${n === 1 ? one : many}`;
const commits = (n: number): string => plural(n, 'commit', 'commits');

/** What a finished action tells the person, and what Undo can bring back. */
export interface Outcome {
  text: string;
  /** Pass to `undo`; null when there is nothing to undo. */
  undo: number | null;
}

/**
 * The git operations a person starts, shared by the views and the commands. Each one logs what failed to the Githor
 * output channel and refreshes the model when it is done.
 */
export class Actions {
  private readonly undoable = new Map<number, { root: RepoRoot; branches: DeletedBranch[] }>();
  private nextUndo = 1;
  /** The scan each dialog opened, by target, so a delete acts on what was checked, not on what a page sends. */
  private readonly scans = new Map<string, MergedBranch[]>();

  constructor(
    private readonly model: RepoModel,
    private readonly output: vscode.OutputChannel
  ) {}

  private root(): RepoRoot {
    if (!this.model.root) throw new Error('Open a folder that is a git repository.');
    return this.model.root;
  }

  private log(what: string, e: unknown): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${what} failed:\n${errorText(e)}\n`);
  }

  async fetch({ all }: { all: boolean }): Promise<void> {
    const root = this.root();
    this.model.setFetch({ fetching: true, error: this.model.fetchError });
    try {
      await fetchRemotes(this.model.git, root, { all });
      this.model.setFetch({ fetching: false, error: null });
    } catch (e) {
      this.log(all ? 'git fetch --all' : 'git fetch', e);
      this.model.setFetch({ fetching: false, error: errorText(e) });
    }
    await this.model.refresh();
  }

  async switchTo(ref: string): Promise<void> {
    const branch = this.model.branches.find((b) => b.ref === ref);
    if (!branch) return;
    try {
      await switchBranch(this.model.git, this.root(), branch);
    } catch (e) {
      this.log(`Switch to ${branch.name}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
  }

  private branch(ref: string): Branch {
    const branch = this.model.branches.find((b) => b.ref === ref);
    if (!branch) throw new Error('That branch is gone. The list is up to date now.');
    return branch;
  }

  /** Runs one sync operation: marks the model busy, logs a failure, re-reads the repository when done. */
  private async syncing<T>(busy: BusyView, what: string, run: () => Promise<T>): Promise<T> {
    this.model.setBusy(busy);
    try {
      return await run();
    } catch (e) {
      this.log(what, e);
      throw e;
    } finally {
      this.model.setBusy(null);
      await this.model.refresh();
    }
  }

  async push({ ref, force, tags }: { ref: string; force: boolean; tags: boolean }): Promise<Outcome> {
    const branch = this.branch(ref);
    if (!force) {
      const why = cannotPush(branch);
      if (why) throw new Error(why);
    }
    await this.syncing({ action: 'push', ref }, `${force ? 'Force-push' : 'Push'} ${branch.name}`, () => push(this.model.git, this.root(), { branch, force, tags }));
    const where = branch.upstream ?? '';
    const text = force ? `Force-pushed ${branch.name} to ${where}` : `Pushed ${commits(branch.ahead)} to ${where}`;
    return { text: tags ? `${text}, with tags` : text, undo: null };
  }

  async pull(ref: string): Promise<Outcome> {
    const branch = this.branch(ref);
    const why = cannotPull(branch);
    if (why) throw new Error(why);
    const n = await this.syncing({ action: 'pull', ref }, `Pull ${branch.name}`, () => pull(this.model.git, this.root(), branch));
    return { text: n ? `Pulled ${commits(n)} into ${branch.name}` : `${branch.name} is already up to date`, undo: null };
  }

  async publish(ref: string): Promise<Outcome> {
    const branch = this.branch(ref);
    const upstream = await this.syncing({ action: 'publish', ref }, `Publish ${branch.name}`, () => publish(this.model.git, this.root(), branch));
    return { text: `Published ${branch.name} to ${upstream}`, undo: null };
  }

  /** Pull, then push, on the current branch (design `44`). A branch on no remote yet is published. */
  async sync(): Promise<Outcome> {
    const current = this.model.current;
    if (!current) throw new Error('No branch is checked out.');
    if (current.sync === 'unpushed' || current.sync === 'gone') return this.publish(current.ref);
    const why = cannotPull(current);
    if (why) throw new Error(why);
    const { pulled, pushed } = await this.syncing({ action: 'sync', ref: null }, `Sync ${current.name}`, async () => {
      const pulled = await pull(this.model.git, this.root(), current);
      await this.model.refresh();
      const after = this.model.current;
      if (!after?.ahead || after.ref !== current.ref) return { pulled, pushed: 0 };
      await push(this.model.git, this.root(), { branch: after });
      return { pulled, pushed: after.ahead };
    });
    const parts = [pulled ? `pulled ${commits(pulled)}` : '', pushed ? `pushed ${commits(pushed)}` : ''].filter(Boolean);
    return { text: parts.length ? `Synced: ${parts.join(' and ')}` : `${current.name} is in sync`, undo: null };
  }

  /** What a force-push of `ref` removes from its remote. */
  forceInfo(ref: string): Promise<{ count: number; authors: string[] }> {
    return remoteOnlyCommits(this.model.git, this.root(), this.branch(ref));
  }

  /**
   * The status bar's click (design `06`): push what is ahead, pull what is behind, publish a new branch. Null when the
   * click has nothing to do but open the branch picker.
   */
  primary(): (() => Promise<Outcome>) | null {
    const branch = this.model.current;
    if (!branch) return null;
    if (branch.sync === 'unpushed' || branch.sync === 'gone') return () => this.publish(branch.ref);
    if (branch.sync === 'ahead') return () => this.push({ ref: branch.ref, force: false, tags: false });
    if (branch.sync === 'behind') return () => this.pull(branch.ref);
    return null;
  }

  /** The merged branches for the dialog; a null target means the default branch. */
  async scanMerged(target: string | null): Promise<MergedView> {
    const { model } = this;
    const targets = mergeTargets(model.branches, model.defaultBranch);
    const chosen = target ?? targets[0];
    if (!chosen) throw new Error('This repository has no branch to compare with.');
    const taskDirs = [this.root(), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
    const scan = await scanMerged({ git: model.git, root: this.root(), target: chosen, current: model.current?.name ?? null, protect: model.defaultBranch ? [model.defaultBranch] : [], taskDirs });
    this.scans.set(chosen, scan.merged);
    return { target: chosen, targets: targets.includes(chosen) ? targets : [chosen, ...targets], merged: scan.merged, kept: scan.kept };
  }

  async deleteMerged({ target, names, onRemote }: { target: string; names: readonly string[]; onRemote: boolean }): Promise<Outcome> {
    const scanned = this.scans.get(target);
    if (!scanned) throw new Error('The list is out of date. Open the dialog again.');
    const root = this.root();
    const chosen = scanned.filter((b) => names.includes(b.name));
    const result = await deleteBranches(this.model.git, root, { branches: chosen, onRemote });
    for (const f of result.failed) this.log(`Delete ${f.name}`, f.error);
    this.scans.delete(target);
    await this.model.refresh();

    const undo = result.deleted.length ? this.nextUndo++ : null;
    if (undo !== null) this.undoable.set(undo, { root, branches: result.deleted });
    const parts = [`Deleted ${plural(result.deleted.length, 'merged branch')}`];
    if (result.deletedOnRemote.length) parts.push(`${result.deletedOnRemote.length} on origin`);
    if (result.failed.length) parts.push(`${result.failed.length} failed, see the Githor output`);
    return { text: parts.join(', '), undo };
  }

  async undo(id: number): Promise<Outcome> {
    const record = this.undoable.get(id);
    if (!record) return { text: 'There is nothing to undo.', undo: null };
    this.undoable.delete(id);
    const failed = await restoreBranches(this.model.git, record.root, record.branches);
    for (const name of failed) this.log(`Restore ${name}`, 'a branch of that name exists, or its commit is gone');
    await this.model.refresh();
    const restored = record.branches.length - failed.length;
    return { text: failed.length ? `Restored ${plural(restored, 'branch')}; ${failed.join(', ')} could not be restored` : `Restored ${plural(restored, 'branch')}`, undo: null };
  }
}
