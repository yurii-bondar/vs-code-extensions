# Githor

Your git branches at a glance: what to push, what to pull, what is merged. Switch with a click, and clear out merged branches, squash and rebase merges included.

## Use

Click the Githor hammer in the Activity Bar: the **Branches** view opens in the sidebar. **Githor: Open in Editor** (or the button in the view's title bar) shows the same list in an editor tab, with the Git menu under `⋯`. Both show the repository of the active editor and follow it as you change files.

### The branch list

Each row shows where the branch lives and how far it is from its remote copy:

| Row | Means |
|---|---|
| `local ↑2` `remote` | 2 commits to push |
| `local` `remote ↓3` | 3 commits to pull |
| `local ↑1` `remote ↓2` `⇅` | both moved: 1 to push, 2 to pull |
| `local ↑2` | never pushed; 2 commits no remote has |
| `local` `remote` `✓ in sync` | nothing to do |
| `remote` | only on the remote |
| `local` alone | its remote branch was deleted |

Filter by name, or by **All**, **Attention** (something to push, pull or clean up), **Local** (on this machine only) and **Remote** (on a remote only). Hover a row and click **Switch** to check the branch out; a remote-only branch gets a local branch that tracks it. The list starts with the current branch, then pinned ones, then the rest, newest first.

### Commit log

The editor tab shows the log of every branch, remote branch and tag between the branch list and the commit's details, with a graph of the lanes. Each commit has its refs (`local`, `remote`, both, or a tag), its author, age and hash.

- **Search** filters by message, hash or author; **Only mine** keeps your commits (by `user.email`). Both search the newest commits loaded; **Load more** reads further back.
- Click a branch in the list to **highlight** it: commits it does not reach are dimmed. The current branch is highlighted otherwise.
- Click a commit to see its message and changed files. Cmd-click (Ctrl-click) selects several commits.
- Click a file to open it **side by side**: before on the left, after on the right, one row per line pair so the sides never drift apart, removed and added lines tinted and the changed words inside a line marked, with keywords, strings and comments coloured. The commit's other files are listed beside it; **Back to log** (or Escape) returns. A binary or very large file, and any file on request, opens in VS Code's diff editor instead.
- Select two or more commits and **Squash N commits…** joins them into one: the screen lists them, the files of the result (click one to see it side by side), and a new message made of their subjects. The commits have to sit next to each other on the current branch; squash is off on the default branch, and warns when the commits are already on origin (a force-push follows). Later commits are put back on top unchanged. **Undo** brings the commits back.
- **Switch** checks a commit out on no branch. **Cherry-pick** applies commits onto the current branch, oldest first; **Revert** adds a commit that undoes one. Both offer **Undo**. A cherry-pick or revert that stops at a conflict is aborted at once, so nothing changes: resolving conflicts comes with the merge screens.

### Commit

The **Commit** tab of the editor lists what the working copy changed since the last commit, in two sections: **Changes** (tracked files) and **Unversioned Files** (new files git does not track yet). Tracked files start ticked, unversioned ones unticked, so a stray file never slips into a commit; a section's or directory's box ticks everything under it.

- The **Group by** button switches between a flat list and one grouped by **Directory**; **Ungroup** goes back. The choice stays in the workspace.
- Click a file to see it side by side: the last commit on the left, your working copy on the right.
- **Commit** commits exactly the ticked files as they are now; anything else you had staged stays staged and out of the commit. **Undo** puts the commit's changes back in the working copy.
- **Commit and push** commits, then opens the push screen.
- Files left in a conflict are listed above, and committing waits until they are resolved.

The editor's **Push** opens the push screen first: where the commits go, each commit with its files (click one to see it side by side), and **Push** or **Cancel**. The sidebar's Push pushes at once.

### Push, pull and sync

The editor toolbar and the sidebar have **Sync**, **Pull** and **Push** for the current branch; a row offers **Push 2**, **Pull 3** or **Publish** on hover, for any branch.

- **Pull** is fast-forward only. The checked-out branch pulls; another branch moves without switching to it (`git fetch origin main:main`).
- **Push**'s arrow opens its options: **Force-push with lease** (turned off on the default branch, and confirmed first with what it removes from origin) and **Push tags**.
- A branch on no remote yet says **Publish**, and gets a remote branch it tracks.
- **Sync** pulls, then pushes.
- A branch where local and remote both moved cannot be pulled or synced plainly. Its `⇅` (or **Compare with remote** in its menu) opens the compare screen: what only each side has, where they start from, the files that will conflict, and three ways to bring them together: **Rebase on remote**, **Merge remote**, or **Force-push…**, which asks first with whose commits leave origin. A branch that is not checked out is switched to first.

### Conflicts

A merge or rebase that stops at a conflict opens the conflict screens in the editor tab (the sidebar says so, with **Resolve side by side** and **Abort**). Your branch is always on the left and the other side on the right, whether git calls them "ours" or "theirs": in a rebase git swaps the two, Githor does not.

- For each conflict: **Accept** your branch, **Accept** the other, **Accept both** (yours first), or **Edit result…** to write the lines yourself. The result is shown under it; **Change** chooses again.
- Files are listed as **Files with conflicts**, **Resolved by you** and **Merged on their own**.
- **Continue** makes the merge commit, or replays the rest of the rebase, which may stop at the next conflict. **Abort** puts the branch back exactly as it was. Pull, Push and Sync wait until it is done.
- A finished merge offers **Undo merge** when Githor started it.

Githor uses the credentials git already has (SSH keys, the system keychain); it never asks for a password.

### The branch menu

`⋯` on a row (on hover) opens what can be done with that branch: **Switch**, **New branch from here…**, **Pull**, **Push**, **Sync** or **Publish to origin**, **Rename…**, **Pin**, **Copy name** and **Delete…** (**Delete on origin…** for a branch only on the remote). What cannot be done says why: the current branch and the default branch cannot be deleted.

- **New branch** takes a name (starting with the start branch's prefix, such as `feat/`), a start point, and whether to switch to it now. Typing a name no branch has in the filter, or in **Switch branch…**, offers to create it.
- **Rename** checks the name as you type, and can rename the branch on origin too.
- **Delete** says what is lost first: fully merged into the default branch, or the commits only this branch has. **Also delete origin/…** names whose commits leave origin. **Undo** restores the local branch; nothing restores a branch deleted on origin.
- **Pin** keeps a branch right after the current one. Pins are per repository and stay in the workspace.

### Status bar

The current branch with the same marks: `↑2`, `↓3`, `↑1 ↓2`, `✓ in sync`. A click pushes what is ahead, pulls what is behind and publishes a new branch; otherwise it opens the branch picker.

### Delete all merged branches

`⋯` → **Delete all merged branches…** (or the command of that name) lists the local branches whose work is already in the target, `main` by default. It finds more than `git branch --merged`, which sees only regular merges:

- regular and fast-forward merges
- squash merges, and squashes that also resolved conflicts
- rebase merges and cherry-picks
- merged stacks: a branch squash-merged into the one above it, which then reached the target
- early drafts of work the target holds in a reworked form

Never listed: the target, `main`, `master`, the default branch and the current branch. Kept, with the reason shown: a branch checked out in another worktree, and one an unfinished Claudestrator task made. **Also delete them on origin** removes a branch's copy on origin only when that copy is merged too. **Undo** brings the local branches back at their old commits; nothing brings back a branch deleted on origin.

### Fetch

The refresh button fetches the current branch's remote; `⋯` → **Fetch all** fetches every remote. When a fetch fails the list says so and offers **Try again** and **Show git output**.

## Requirements

VS Code's built-in Git extension (`git.enabled`). Githor runs the same `git` it found, so your config, credentials and hooks apply. Delete merged branches needs git 2.38 or later for its squash and stack checks (`git merge-tree --write-tree`); with an older git it finds fewer branches, never more.

## How it works

- `src/core/` is pure logic with no `vscode` import, tested against real repositories: `branches.ts` reads `git for-each-ref`, `marks.ts` is the sync language of the design (also imported by the webview), `merged.ts` decides what is merged, `cleanup.ts` deletes and restores, `remote.ts` fetches, `sync.ts` pushes and pulls (`sync-rules.ts` says when they are offered), `branch-ops.ts` creates, renames and deletes one branch, `log.ts` reads the log and one commit, `graph.ts` lays out the lanes (also imported by the webview), `commit-ops.ts` switches to, cherry-picks and reverts commits, `side-by-side.ts` pairs a diff's lines and marks changed words, `file-diff.ts` reads one file's diff, `working.ts` reads and commits the working copy, `commit-groups.ts` builds the commit list's sections and groups, `compare.ts` compares a branch with its remote, `operation.ts` runs a merge or rebase and resolves its files, `conflict.ts` reads conflict markers with your side on the left, `squash.ts` plans and makes a squash, `tasks.ts` reads Claudestrator's task records, `repos.ts` picks the repository.
- `src/model.ts` reads the repository once for every view and re-reads when the Git extension reports a change. `src/actions.ts` runs the git operations and logs failures to the **Githor** output channel.
- `src/branches-view.ts` drives one webview page; `src/sidebar.ts` puts it in the sidebar, `src/panel.ts` in an editor tab. `src/status-bar.ts` and `src/quick-pick.ts` are the status bar item and the branch switcher; `src/git-content.ts` serves files at a commit to VS Code's diff editor.
- `media/*.ts` are the page's ES modules: `main.ts` (state and events), `branch-list.ts`, `sync-controls.ts` (Sync, Pull, Push and its menu), `branch-menu.ts`, `branch-dialogs.ts` (new, rename, delete), `commit-log.ts`, `commit-details.ts`, `diff-view.ts`, `syntax.ts` (the diff's colours), `commit-view.ts`, `push-review.ts`, `compare-view.ts`, `conflict-view.ts`, `squash-view.ts`, `chrome.ts` (toolbar, menu, banner, toast), `merged-dialog.ts`, `icons.ts` (the design's icons). `media/app.css` holds the design tokens and components.

## Develop

```sh
npm install
npm run build       # dist/
npm run typecheck
npm run lint
npm test            # builds, then node --test; git tests run against real repositories in a temp dir
```

Press F5 in this folder to start an Extension Development Host.

## License

MIT
