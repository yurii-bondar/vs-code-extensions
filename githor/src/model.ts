import * as vscode from 'vscode';
import * as path from 'path';
import { defaultBranch, listBranches, sortBranches } from './core/branches';
import { lastFetchedAt } from './core/remote';
import { pickRepo } from './core/repos';
import type { GitRunner } from './core/git';
import type { Branch, RepoRoot } from './core/types';
import type { API, Repository } from './git-api';
import type { BusyView, StateView } from './protocol';

/** The Git extension reports a change several times in a row; one refresh follows the last of them. */
const REFRESH_DELAY_MS = 300;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fileOf = (editor: vscode.TextEditor | undefined): string | undefined => {
  const uri = editor?.document.uri;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
};

/**
 * The repository Githor shows, read once for every view: the sidebar, the editor tab and the status bar. It follows
 * the active editor and re-reads when the Git extension reports a change.
 */
export class RepoModel implements vscode.Disposable {
  root: RepoRoot | null;
  branches: Branch[] = [];
  loaded = false;
  fetchedAt: number | null = null;
  fetching = false;
  fetchError: string | null = null;
  defaultBranch: string | null = null;
  busy: BusyView | null = null;

  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after the state changed. */
  readonly onDidChange = this.changed.event;
  private readonly failed = new vscode.EventEmitter<string>();
  /** Fires with git's message when reading the repository fails. */
  readonly onDidFail = this.failed.event;

  /** Bumped by every refresh, so a slow `git` call cannot overwrite the answer of a later one. */
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly watched = new Map<Repository, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [this.changed, this.failed];

  constructor(
    private readonly api: API,
    readonly git: GitRunner,
    /** Where pinned branches are kept, per repository: the workspace's state. */
    private readonly memento: vscode.Memento
  ) {
    this.root = pickRepo({ roots: this.roots(), file: fileOf(vscode.window.activeTextEditor) });
    for (const repo of api.repositories) this.watch(repo);
    this.disposables.push(
      api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.refreshSoon();
      }),
      api.onDidCloseRepository((repo) => {
        this.watched.get(repo)?.dispose();
        this.watched.delete(repo);
        this.refreshSoon();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const root = pickRepo({ roots: this.roots(), file: fileOf(editor), current: this.root });
        if (root === this.root) return;
        this.root = root;
        this.refreshSoon();
      })
    );
  }

  get current(): Branch | undefined {
    return this.branches.find((b) => b.current);
  }

  state(): StateView {
    const { root } = this;
    return {
      repo: root && { name: path.basename(root), root },
      branches: this.branches,
      loaded: this.loaded,
      fetchedAt: this.fetchedAt,
      fetching: this.fetching,
      fetchError: this.fetchError,
      defaultBranch: this.defaultBranch,
      busy: this.busy,
    };
  }

  /** Sets fetch progress or its outcome, and tells the views. */
  setFetch({ fetching, error }: { fetching: boolean; error: string | null }): void {
    this.fetching = fetching;
    this.fetchError = error;
    this.changed.fire();
  }

  setBusy(busy: BusyView | null): void {
    this.busy = busy;
    this.changed.fire();
  }

  refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), REFRESH_DELAY_MS);
  }

  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const root = (this.root = pickRepo({ roots: this.roots(), current: this.root }));
    try {
      const [branches, fetchedAt, main] = root ? await Promise.all([listBranches(this.git, root), lastFetchedAt(this.git, root), defaultBranch(this.git, root)]) : [[], null, null];
      if (generation !== this.generation) return;
      Object.assign(this, { branches: root ? sortBranches(branches, this.pins(root)) : [], fetchedAt, defaultBranch: main, loaded: true });
      this.changed.fire();
    } catch (e) {
      if (generation === this.generation) this.failed.fire(errorText(e));
    }
  }

  private pins(root: RepoRoot): Set<string> {
    const saved: unknown = this.memento.get(`githor.pins:${root}`);
    return new Set(Array.isArray(saved) ? saved.filter((n): n is string => typeof n === 'string') : []);
  }

  /** Pins or unpins a branch of the shown repository. */
  async setPinned(name: string, pinned: boolean): Promise<void> {
    if (!this.root) return;
    const pins = this.pins(this.root);
    if (pinned) pins.add(name);
    else pins.delete(name);
    await this.memento.update(`githor.pins:${this.root}`, [...pins]);
    await this.refresh();
  }

  private roots(): RepoRoot[] {
    return this.api.repositories.map((r) => r.rootUri.fsPath as RepoRoot);
  }

  private watch(repo: Repository): void {
    if (!this.watched.has(repo)) this.watched.set(repo, repo.state.onDidChange(() => this.refreshSoon()));
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.watched.values()) d.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
