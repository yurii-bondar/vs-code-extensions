import * as vscode from 'vscode';
import { createBranch, deleteBranch, deleteOnRemote, nameProblem, onlyHere, renameBranch } from './core/branch-ops';
import { switchBranch } from './core/branches';
import { cherryPick, ConflictError, resetTo, revertCommit, switchToCommit } from './core/commit-ops';
import { compareWithRemote } from './core/compare';
import { abortOperation, bringTogether, continueOperation, readConflict, reopenConflict, resolveFile } from './core/operation';
import type { ConflictPart, Resolution } from './core/conflict';
import { fileDiff } from './core/file-diff';
import { squash, squashPlan } from './core/squash';
import { applyStash, dropStash, listStashes, renameStash, restoreStash, stashFileDiff, stashPush } from './core/stash';
import { commitFiles, commitsToPush, uncommit, workingDiff } from './core/working';
import { commitDetails, readLog, userEmail } from './core/log';
import { deleteBranches, restoreBranches } from './core/cleanup';
import { isMergedInto, mergeTargets, scanMerged } from './core/merged';
import { fetchRemotes } from './core/remote';
import { publish, publishRemote, pull, push, remoteOnlyCommits } from './core/sync';
import { cannotPull, cannotPush } from './core/sync-rules';
import type { Branch, CommitDetails, CommitLine, CommitView, CompareView, FileChange, FileDiff, MergedBranch, RepoRoot, SquashPlan, StashView } from './core/types';
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
  /** What each Undo id puts back; it returns the toast's text. */
  private readonly undoable = new Map<number, () => Promise<string>>();
  private nextUndo = 1;
  /** The scan each dialog opened, by target, so a delete acts on what was checked, not on what a page sends. */
  private readonly scans = new Map<string, MergedBranch[]>();
  /** Where the branch was before a merge Githor started, for Undo merge (design `30`). */
  private mergedFrom: { root: RepoRoot; sha: string } | null = null;
  /** How many commits the squash in progress joins, for its toast. */
  private squashed = 0;

  constructor(
    private readonly model: RepoModel,
    private readonly output: vscode.OutputChannel
  ) {}

  private root(): RepoRoot {
    if (!this.model.root) throw new Error('Open a folder that is a git repository.');
    return this.model.root;
  }

  private remember(undo: () => Promise<string>): number {
    const id = this.nextUndo++;
    this.undoable.set(id, undo);
    return id;
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
    if (this.model.operation) throw new Error(`Finish or abort the ${this.model.operation.kind} first.`);
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

  /** Pull, then push (design `44`): the current branch, or the one given. A branch on no remote yet is published. */
  async sync(ref?: string): Promise<Outcome> {
    const current = ref ? this.branch(ref) : this.model.current;
    if (!current) throw new Error('No branch is checked out.');
    if (current.sync === 'unpushed' || current.sync === 'gone') return this.publish(current.ref);
    const why = cannotPull(current);
    if (why) throw new Error(why);
    const { pulled, pushed } = await this.syncing({ action: 'sync', ref: ref ?? null }, `Sync ${current.name}`, async () => {
      const pulled = await pull(this.model.git, this.root(), current);
      await this.model.refresh();
      const after = this.model.branches.find((b) => b.ref === current.ref);
      if (!after?.ahead) return { pulled, pushed: 0 };
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

    const undo = result.deleted.length
      ? this.remember(async () => {
          const failed = await restoreBranches(this.model.git, root, result.deleted);
          for (const name of failed) this.log(`Restore ${name}`, 'a branch of that name exists, or its commit is gone');
          const restored = result.deleted.length - failed.length;
          return failed.length ? `Restored ${plural(restored, 'branch')}; ${failed.join(', ')} could not be restored` : `Restored ${plural(restored, 'branch')}`;
        })
      : null;
    const parts = [`Deleted ${plural(result.deleted.length, 'merged branch')}`];
    if (result.deletedOnRemote.length) parts.push(`${result.deletedOnRemote.length} on origin`);
    if (result.failed.length) parts.push(`${result.failed.length} failed, see the Githor output`);
    return { text: parts.join(', '), undo };
  }

  async undo(id: number): Promise<Outcome> {
    const undo = this.undoable.get(id);
    if (!undo) return { text: 'There is nothing to undo.', undo: null };
    this.undoable.delete(id);
    try {
      return { text: await undo(), undo: null };
    } finally {
      await this.model.refresh();
    }
  }

  // ---------- one branch: the branch menu and its dialogs (31–37, 43) ----------

  checkName(name: string): Promise<string | null> {
    return nameProblem(this.model.git, this.root(), name);
  }

  async newBranch({ name, start, switchTo }: { name: string; start: string; switchTo: boolean }): Promise<Outcome> {
    const problem = await this.checkName(name);
    if (problem) throw new Error(problem);
    const from = this.branch(start);
    try {
      await createBranch(this.model.git, this.root(), { name, start: from.local ? from.ref : (from.upstream ?? from.ref), switchTo });
    } catch (e) {
      this.log(`Create ${name}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    return { text: switchTo ? `Created ${name} and switched to it` : `Created ${name} from ${from.name}`, undo: null };
  }

  async rename({ ref, to, onRemote }: { ref: string; to: string; onRemote: boolean }): Promise<Outcome> {
    const branch = this.branch(ref);
    const problem = await this.checkName(to);
    if (problem) throw new Error(problem);
    const root = this.root();
    try {
      await renameBranch(this.model.git, root, { branch, to, onRemote });
    } catch (e) {
      this.log(`Rename ${branch.name}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    // Undo puts the local name back; a rename on origin is not undone, since others may already use the new name.
    const undo = onRemote ? null : this.remember(async () => {
      await this.model.git.run(root, ['branch', '--move', to, branch.name]);
      return `Renamed back to ${branch.name}`;
    });
    return { text: `Renamed to ${to}`, undo };
  }

  /** What deleting `ref` loses, for the delete dialog (`34`, `35`). */
  async deleteInfo(ref: string): Promise<{ mergedInto: string | null; local: CommitLine[]; remote: CommitLine[] }> {
    const branch = this.branch(ref);
    const { git } = this.model;
    const root = this.root();
    const main = this.model.defaultBranch;
    const [lost, merged] = await Promise.all([
      onlyHere(git, root, { branch, withUpstream: true }),
      main && main !== branch.name && branch.local ? isMergedInto({ git, root, ref: branch.ref, target: main }).catch(() => false) : Promise.resolve(false),
    ]);
    return { mergedInto: merged ? main : null, ...lost };
  }

  async deleteBranch({ ref, onRemote }: { ref: string; onRemote: boolean }): Promise<Outcome> {
    const branch = this.branch(ref);
    if (branch.current) throw new Error('This is your current branch. Switch first.');
    if (branch.name === this.model.defaultBranch) throw new Error(`${branch.name} is the default branch.`);
    const root = this.root();
    try {
      if (branch.local) await deleteBranch(this.model.git, root, { branch, onRemote });
      else if (branch.upstream) await deleteOnRemote(this.model.git, root, branch.upstream);
    } catch (e) {
      this.log(`Delete ${branch.name}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    if (!branch.local) return { text: `Deleted ${branch.upstream ?? branch.name}`, undo: null };
    const undo = this.remember(async () => {
      const failed = await restoreBranches(this.model.git, root, [{ name: branch.name, sha: branch.sha, upstream: branch.upstream }]);
      if (failed.length) throw new Error(`${branch.name} could not be restored: a branch of that name exists.`);
      return `Restored ${branch.name}`;
    });
    return { text: `Deleted ${branch.name}${onRemote && branch.upstream ? ` and ${branch.upstream}` : ''}`, undo };
  }

  async pin(ref: string, pinned: boolean): Promise<void> {
    await this.model.setPinned(this.branch(ref).name, pinned);
  }

  // ---------- the commit log (01, 14) ----------

  async commitLog(limit: number): Promise<{ commits: CommitView[]; hasMore: boolean; me: string | null }> {
    const root = this.root();
    const [log, me] = await Promise.all([readLog({ git: this.model.git, root, limit }), userEmail(this.model.git, root)]);
    return { ...log, me };
  }

  commitDetails(shas: readonly string[]): Promise<CommitDetails[]> {
    return Promise.all(shas.map((sha) => commitDetails(this.model.git, this.root(), sha)));
  }

  // ---------- commit (04, 49–52) and the push screen (10) ----------

  workingDiff(path: string): Promise<FileDiff> {
    const file = this.model.working.find((f) => f.path === path);
    if (!file) throw new Error(`${path} has no change any more.`);
    return workingDiff(this.model.git, this.root(), file);
  }

  /** Commits the chosen files as they are now; Undo puts the commit's changes back in the working copy. */
  async commit({ paths, message }: { paths: readonly string[]; message: string }): Promise<Outcome> {
    const root = this.root();
    const files = this.model.working.filter((f) => paths.includes(f.path) && !f.conflicted);
    if (!files.length) throw new Error('None of these files has a change any more.');
    if (this.model.working.some((f) => f.conflicted)) throw new Error('Some files still conflict. Resolve them first.');
    const onto = this.model.current?.name ?? 'HEAD';
    let made: { sha: string; parent: string | null };
    try {
      made = await commitFiles(this.model.git, root, { files, message });
    } catch (e) {
      this.log('Commit', e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    const { parent } = made;
    const undo = parent
      ? this.remember(async () => {
          await uncommit(this.model.git, root, parent);
          return 'The commit is undone; its changes are back in the working copy';
        })
      : null;
    return { text: `Committed ${plural(files.length, 'file', 'files')} to ${onto}`, undo };
  }

  /** What a push of `ref` sends (design `10`): its commits with their files, and where they go. */
  async pushReview(ref: string): Promise<{ commits: CommitDetails[]; to: string; creates: boolean }> {
    const branch = this.branch(ref);
    const root = this.root();
    const shas = await commitsToPush(this.model.git, root, branch);
    const creates = !branch.upstream || branch.sync === 'gone';
    const remote = creates ? ((await publishRemote(this.model.git, root)) ?? 'origin') : null;
    return { commits: await this.commitDetails(shas), to: creates ? `${remote}/${branch.name}` : (branch.upstream ?? ''), creates };
  }

  fileDiff(args: { sha: string; parent: string | null; file: FileChange }): Promise<FileDiff> {
    return fileDiff(this.model.git, this.root(), args);
  }

  async switchCommit(sha: string): Promise<Outcome> {
    try {
      await switchToCommit(this.model.git, this.root(), sha);
    } catch (e) {
      this.log(`Switch to ${sha.slice(0, 7)}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    return { text: `Switched to ${sha.slice(0, 7)}, on no branch. Create a branch here to keep work made on it.`, undo: null };
  }

  /** Cherry-picks onto the current branch; Undo moves the branch back. A conflict aborts and changes nothing. */
  async cherryPick(shas: readonly string[]): Promise<Outcome> {
    const root = this.root();
    const onto = this.model.current?.name ?? 'HEAD';
    const before = await this.applying(`Cherry-pick ${shas.length} onto ${onto}`, () => cherryPick(this.model.git, root, shas));
    return { text: `Cherry-picked ${commits(shas.length)} onto ${onto}`, undo: this.undoReset(root, before, onto) };
  }

  async revert(sha: string): Promise<Outcome> {
    const root = this.root();
    const onto = this.model.current?.name ?? 'HEAD';
    const before = await this.applying(`Revert ${sha.slice(0, 7)}`, () => revertCommit(this.model.git, root, sha));
    return { text: `Reverted ${sha.slice(0, 7)} on ${onto}`, undo: this.undoReset(root, before, onto) };
  }

  private async applying(what: string, run: () => Promise<string>): Promise<string> {
    try {
      return await run();
    } catch (e) {
      this.log(what, e);
      throw e instanceof ConflictError ? new Error(`${e.message} Resolving conflicts comes with the merge screens.`) : e;
    } finally {
      await this.model.refresh();
    }
  }

  private undoReset(root: RepoRoot, sha: string, branch: string): number {
    return this.remember(async () => {
      await resetTo(this.model.git, root, sha);
      return `${branch} is back at ${sha.slice(0, 7)}`;
    });
  }

  // ---------- compare and merge (03, 23–30) ----------

  private operation(): NonNullable<RepoModel['operation']> {
    const op = this.model.operation;
    if (!op) throw new Error('No merge or rebase is in progress any more.');
    return op;
  }

  compare(ref: string): Promise<CompareView> {
    return compareWithRemote(this.model.git, this.root(), this.branch(ref));
  }

  /**
   * Merges the branch's remote into it, or rebases it onto its remote; a branch that is not checked out is switched
   * to first. A conflict leaves the operation paused, which the state shows; otherwise the toast says it is done.
   */
  async bringTogether({ ref, how }: { ref: string; how: 'merge' | 'rebase' }): Promise<Outcome | null> {
    const branch = this.branch(ref);
    if (!branch.upstream) throw new Error(`${branch.name} has no remote branch.`);
    if (this.model.operation) throw new Error('A merge or rebase is already in progress.');
    const root = this.root();
    const { git } = this.model;
    try {
      if (!branch.current) await switchBranch(git, root, branch);
      const before = (await git.run(root, ['rev-parse', 'HEAD'])).trim();
      this.mergedFrom = { root, sha: before };
      const { paused } = await bringTogether(git, root, { how, other: branch.upstream });
      if (paused) return null;
    } catch (e) {
      this.log(`${how === 'merge' ? 'Merge' : 'Rebase'} ${branch.name}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    return this.finished(how, branch.upstream, branch.name);
  }

  /** The toast after a merge or rebase is done, with Undo when Githor knows where the branch was. */
  private finished(how: 'merge' | 'rebase' | 'squash', remote: string, local: string): Outcome {
    const ahead = this.model.current?.ahead ?? 0;
    const from = this.mergedFrom;
    this.mergedFrom = null;
    const undo = from
      ? this.remember(async () => {
          await resetTo(this.model.git, from.root, from.sha);
          return `The ${how} is undone`;
        })
      : null;
    if (how === 'squash') return { text: `Squashed ${commits(this.squashed)}`, undo };
    const verb = how === 'merge' ? `Merged ${remote} into ${local}` : `Rebased ${local} onto ${remote}`;
    return { text: `${verb}. ${ahead ? `${commits(ahead)} to push` : 'Nothing to push'}`, undo };
  }

  conflictFile(file: string): Promise<ConflictPart[]> {
    return readConflict(this.model.git, this.root(), { file, kind: this.operation().kind });
  }

  async resolveConflict({ path, resolutions }: { path: string; resolutions: readonly Resolution[] }): Promise<void> {
    try {
      await resolveFile(this.model.git, this.root(), { file: path, kind: this.operation().kind, resolutions });
    } finally {
      await this.model.refresh();
    }
  }

  async reopenConflict(path: string): Promise<void> {
    try {
      await reopenConflict(this.model.git, this.root(), path);
    } finally {
      await this.model.refresh();
    }
  }

  /** Continue: the merge commit, or the rest of the rebase, which can pause at the next conflict. */
  async continueOperation(): Promise<Outcome | null> {
    const op = this.operation();
    if (op.conflicted.length) throw new Error('Resolve every conflict first.');
    let paused: boolean;
    try {
      ({ paused } = await continueOperation(this.model.git, this.root(), op.kind));
    } catch (e) {
      this.log(`Continue the ${op.kind}`, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    return paused ? null : this.finished(op.kind, op.remote, op.local);
  }

  async abortOperation(): Promise<Outcome> {
    const op = this.operation();
    try {
      await abortOperation(this.model.git, this.root(), op.kind);
    } finally {
      this.mergedFrom = null;
      await this.model.refresh();
    }
    const word = { merge: 'Merge', rebase: 'Rebase', squash: 'Squash' }[op.kind];
    return { text: `${word} aborted: the branch is back as it was`, undo: null };
  }

  // ---------- squash (12–22) ----------

  squashPlan(shas: readonly string[]): Promise<SquashPlan> {
    const { model } = this;
    return squashPlan({ git: model.git, root: this.root(), shas, branch: model.current?.name ?? null, defaultBranch: model.defaultBranch });
  }

  /** Squashes the commits; a conflict while putting later ones back pauses it, and Continue finishes it. */
  async squash({ shas, message }: { shas: readonly string[]; message: string }): Promise<Outcome | null> {
    if (this.model.operation) throw new Error(`Finish or abort the ${this.model.operation.kind} first.`);
    const root = this.root();
    const plan = await this.squashPlan(shas);
    if (plan.problem) throw new Error(plan.problem);
    this.squashed = plan.commits.length;
    try {
      const { oldHead, movedRef, paused } = await squash(this.model.git, root, { plan, message });
      if (movedRef) {
        // a branch that is not checked out moved: Undo moves its ref back, whatever is checked out meanwhile
        const undo = this.remember(async () => {
          await this.model.git.run(root, ['update-ref', movedRef, oldHead]);
          return 'The squash is undone';
        });
        return { text: `Squashed ${commits(plan.commits.length)} on ${plan.branch}`, undo };
      }
      this.mergedFrom = { root, sha: oldHead };
      if (paused) return null;
    } catch (e) {
      this.log('Squash', e);
      throw e;
    } finally {
      await this.model.refresh();
    }
    return this.finished('squash', '', this.model.current?.name ?? 'HEAD');
  }

  // ---------- stash (09) ----------

  stashes(): Promise<StashView[]> {
    return listStashes(this.model.git, this.root());
  }

  stashDiff(args: { sha: string; file: FileChange }): Promise<FileDiff> {
    return stashFileDiff(this.model.git, this.root(), args);
  }

  /** Runs a stash operation, logging a failure and re-reading the repository after. */
  private async stashing<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      this.log(what, e);
      throw e;
    } finally {
      await this.model.refresh();
    }
  }

  async stashPush(args: { message: string; paths: readonly string[] | null; includeUntracked: boolean }): Promise<Outcome> {
    const sha = await this.stashing('Stash', () => stashPush(this.model.git, this.root(), args));
    if (!sha) return { text: 'There was nothing to stash', undo: null };
    const n = args.paths?.length;
    return { text: n ? `Stashed ${plural(n, 'file', 'files')}` : 'Stashed your changes', undo: null };
  }

  async stashApply(sha: string): Promise<Outcome> {
    await this.stashing('Apply the stash', () => applyStash(this.model.git, this.root(), sha));
    const conflicts = this.model.working.filter((f) => f.conflicted).length;
    return { text: conflicts ? `Applied, with ${plural(conflicts, 'file', 'files')} in conflict: see the Commit tab` : 'Applied the stash; it is kept', undo: null };
  }

  async stashDrop(sha: string): Promise<Outcome> {
    const root = this.root();
    const dropped = await this.stashing('Delete the stash', () => dropStash(this.model.git, root, sha));
    const undo = this.remember(async () => {
      await restoreStash(this.model.git, root, dropped);
      return 'The stash is back';
    });
    return { text: 'Deleted the stash', undo };
  }

  async stashRename({ sha, message }: { sha: string; message: string }): Promise<Outcome> {
    await this.stashing('Rename the stash', () => renameStash(this.model.git, this.root(), { sha, message }));
    return { text: `Renamed the stash to ${message}`, undo: null };
  }
}
