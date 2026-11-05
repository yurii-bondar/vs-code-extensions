import * as vscode from 'vscode';
import { switchBranch } from './core/branches';
import { deleteBranches, restoreBranches } from './core/cleanup';
import { mergeTargets, scanMerged } from './core/merged';
import { fetchRemotes } from './core/remote';
import type { DeletedBranch, MergedBranch, RepoRoot } from './core/types';
import type { RepoModel } from './model';
import type { MergedView } from './protocol';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many = `${one}es`): string => `${n} ${n === 1 ? one : many}`;

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
