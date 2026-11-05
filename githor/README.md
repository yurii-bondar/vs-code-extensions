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

Filter by name, or by **All**, **Attention** (something to push, pull or clean up), **Local** (on this machine only) and **Remote** (on a remote only). Hover a row and click **Switch** to check the branch out; a remote-only branch gets a local branch that tracks it.

### Push, pull and sync

The editor toolbar and the sidebar have **Sync**, **Pull** and **Push** for the current branch; a row offers **Push 2**, **Pull 3** or **Publish** on hover, for any branch.

- **Pull** is fast-forward only. The checked-out branch pulls; another branch moves without switching to it (`git fetch origin main:main`).
- **Push**'s arrow opens its options: **Force-push with lease** (turned off on the default branch, and confirmed first with what it removes from origin) and **Push tags**.
- A branch on no remote yet says **Publish**, and gets a remote branch it tracks.
- **Sync** pulls, then pushes.
- A branch where local and remote both moved cannot be pulled or synced: there is no automatic merge that could stop at a conflict. Compare them, or force-push.

Githor uses the credentials git already has (SSH keys, the system keychain); it never asks for a password.

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

- `src/core/` is pure logic with no `vscode` import, tested against real repositories: `branches.ts` reads `git for-each-ref`, `marks.ts` is the sync language of the design (also imported by the webview), `merged.ts` decides what is merged, `cleanup.ts` deletes and restores, `remote.ts` fetches, `sync.ts` pushes and pulls (`sync-rules.ts` says when they are offered), `tasks.ts` reads Claudestrator's task records, `repos.ts` picks the repository.
- `src/model.ts` reads the repository once for every view and re-reads when the Git extension reports a change. `src/actions.ts` runs the git operations and logs failures to the **Githor** output channel.
- `src/branches-view.ts` drives one webview page; `src/sidebar.ts` puts it in the sidebar, `src/panel.ts` in an editor tab. `src/status-bar.ts` and `src/quick-pick.ts` are the status bar item and the branch switcher.
- `media/*.ts` are the page's ES modules: `main.ts` (state and events), `branch-list.ts`, `sync-controls.ts` (Sync, Pull, Push and its menu), `chrome.ts` (toolbar, menu, banner, toast), `merged-dialog.ts`, `icons.ts` (the design's icons). `media/app.css` holds the design tokens and components.

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
