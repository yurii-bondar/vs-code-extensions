# Githor design map and plan

Where each screen lives, what it has to do in git, and a suggested order to build it. The Penpot file is the source of truth for how things look. This file is the index.

**Design file:** "Githor — Design System" in the local Penpot, `http://localhost:9001`.

The git commands below are suggestions written while designing. None of them has been run from this project, so check each one when you build it.

## Pages and screens

Screens are numbered by the order they were designed, not by the order a user meets them. Prototype links work only inside one page, because Penpot cannot link across pages.

| Page | Screen | What it shows |
|---|---|---|
| Foundations | | Colours, type, spacing, sync language |
| Components | | `Branch row`, `Sync badge`, `Chip`, `Button`, `Icon button`, `Input`, `Filter`, `Tab`, `Toast`, `Commit row`, `File row`, `Stage row`, `Diff row`, `Ref`, `Avatar`, `Count`, `Kbd`, icons |
| Log and diff | `01 Log` | Main window: branch list, commit graph, commit details |
| | `02 Side-by-side diff` | Two-column diff with changed words marked |
| | `14 Log, commits selected` | Several commits selected, `Squash 2 commits…` and `Cherry-pick 2` |
| | `05 Sidebar view` | The compact sidebar version |
| | `06 Status bar` | Status bar item per sync state, and what a click does |
| | `07 Quick pick` | Branch switcher |
| | `08 States` | Empty and in-progress states |
| Commit, push, stash | `04 Commit` | Staging and commit message |
| | `09 Stash` | Stash list, with rename and delete |
| | `10 Push` | Commit-and-push screen with the commits to send |
| | `11 Push states` | Push menu, force-push, `Push tags`, new branch on origin |
| | `44 Synced` | After `Sync`: branch in sync, `Push` disabled |
| | `49 Commit, unversioned files` | The file list in two sections, `Changes` and `Unversioned Files`, ungrouped |
| | `50 Commit, group by menu` | The `Group by` button's menu: `Directory`, `Repository`, `Ungroup` |
| | `51 Commit, grouped by directory` | Each section as a tree of directories |
| | `52 Commit, grouped by repository` | Several repositories in one commit, each on its own branch |
| Squash | `12 Squash`, `13 Squash states` | Squash screen and its variants |
| | `15 Log after squash` | Result, with `Undo` |
| | `16 Squash conflict` | Paused at a conflict |
| | `21`, `17`, `22` | Accepted squashed, accepted `a7f3c21`, accepted both |
| | `18`, `19`, `20` | Edit result: opened, changed, saved |
| Merge | `03 Compare local and remote` | Diverged branch: rebase, merge or force-push |
| | `23 Merge conflict` | Paused, with `Accept {branch}` buttons |
| | `24`, `25`, `26` | Accepted local, accepted remote, accepted both |
| | `27`, `28`, `29` | Edit result: opened, changed, saved |
| | `30 Merge finished` | Merge commit, 2 to push, `Undo merge` |
| Branches and Git menu | `31 Branch menu` | Menu on a branch, opened with `⋯` |
| | `32 Branch menu states` | Current, default, local-only and remote-only branch |
| | `33`, `34`, `35` | Rename, delete, and their states |
| | `36`, `37` | Results, with `Undo` |
| | `43 New branch` | Name, start point, switch to it |
| | `38 Git menu` | The general menu: `⋯` in the toolbar |
| | `39`, `40`, `41`, `42` | `Delete all merged branches in [main ▾]`, branch picker, other target, result |
| Accounts | `45 Account menu` | Switcher in the status bar |
| | `46 Manage accounts` | This repo, account list, rules by remote |
| | `47 Add account` | Provider, sign-in, commit identity |
| | `48 Account states` | Wrong account, push rejected, expired sign-in, none yet, remove, after switching |

## Rules that apply everywhere

**Branch row sync marks.** These replaced the text labels, so `to push`, `to pull`, `not pushed` and `diverged` no longer appear as row badges.

| State | `local` chip | `remote` chip | Right side |
|---|---|---|---|
| Ahead 2 | `↑2` | | |
| Behind 3 | | `↓3` | |
| Ahead 1, behind 2 | `↑1` | `↓2` | `⇅` icon, click opens `03` |
| No upstream, 2 commits | `↑2` | no chip | |
| Both zero | | | `in sync` |
| Only on remote | no chip | | |

- A zero count is not shown.
- A row with one chip keeps that chip on the left.
- There is no `deleted on remote` or `only on remote` label. `gone` shows as a local chip alone.
- `↑` uses `sync.ahead`, `↓` uses `sync.behind`.
- On hover the row shows `Switch`, `⋯` and, where one applies, an action such as `Pull 3`.

**Status bar** uses the same marks: `↑2`, `↓3`, `↑1 ↓2`, `in sync`. The account switcher sits on the right.

**Wording.** Use `Switch`, never `Check out`, including on a commit. Use `Stash`, never `Shelve`.

**Conflict buttons.** Merge: `Accept {local branch}`, `Accept {remote branch}`, `Accept both`, `Edit result…`. Squash happens on one branch, so the buttons name the sides instead: `Accept squashed`, `Accept {sha}`.

**Destructive actions.** They name what is lost before it happens. Force-push and delete on origin stay available, with the reason shown. `Undo` is offered only for what it can restore: it does not appear after a push, and dialogs say when origin cannot be restored.

**While paused at a conflict:** `Pull`, `Push`, `Sync` and `Continue` are disabled until the conflict is resolved. `Abort` is always available.

## Where the code stands

Built in `githor/`, following the build order below (see `README.md` for what each does):

| Step | Screens | State |
|---|---|---|
| 1 | `01`, `05`, `06`, `07`, `08` | Branch row marks, filters, status bar, quick pick, empty and fetch-failed states |
| 2 | `11`, `44` | Pull (fast-forward only), Push with its menu (force-push with lease, tags), Publish, Sync, row actions |
| 3 | `31`–`37`, `43` | Branch menu, new, rename, delete with Undo, pin, copy name; create from the filter and the quick pick |
| 4 | `38`–`42` | Git menu, Delete all merged branches with the checks of `delete-merged-main-branches.sh`, so squash and rebase merges count |
| 5 | `01`, `14` | Log with graph, search, Only mine, highlighting, details, Switch, Cherry-pick, Revert with Undo |
| 6 | `02` | Side-by-side diff with changed words marked |
| 7 | `04`, `10`, `49`–`51` | Commit tab with sections and directory grouping, Commit and push, the push screen |

Left out on purpose, with their reason:

- **Menu items whose screens come later** are not shown dead: `Compare with remote`, `Merge into`, `Rebase onto` (step 8), `Squash` (step 9), `Stash` (step 10), `Accounts…` (step 11), `Open settings` (Githor has no settings).
- **Conflicts.** A cherry-pick or revert that stops at a conflict is aborted at once, so nothing changes; Pull is fast-forward only and Sync is off for a diverged branch, until the conflict screens exist.
- **`52 Grouped by repository`.** Githor shows one repository at a time; `Repository` joins the Group by menu once the model holds every open repository.
- **Search** covers the commits loaded (300 at a time), and the graph draws up to 8 lanes.

`src/core/git.ts` sets `GIT_TERMINAL_PROMPT=0`: push and pull use the credentials git already has (SSH, the keychain), and fail instead of asking. Choosing between accounts is step 11.

## Suggested build order

Each step is usable alone and needs only what comes before it. Follow `.claude/rules/principles.md`: pure logic in `src/core/` with tests against real repositories in a temp dir, as `test/branches.test.ts` does. Add each new message to `src/protocol.ts`.

1. Branch row marks, filters, and status bar item (`01`, `05`, `06`)
2. Pull, Push, Sync, Fetch (toolbar, `11`, `44`)
3. Branch menu with new, rename, delete, pin, copy (`31`–`37`, `43`)
4. Git menu and delete merged branches (`38`–`42`)
5. Commit log with graph (`01`, `14`)
6. Side-by-side diff (`02`)
7. Commit and commit-and-push (`04`, `10`)
8. Compare and merge, with the conflict screens (`03`, `23`–`30`)
9. Squash, reusing the conflict screens (`12`–`22`)
10. Stash (`09`)
11. Accounts (`45`–`48`). Do the spike below earlier, since it affects step 2

## Behaviour by feature

### Sync, pull, push

- **Pull, push:** `git pull`, `git push`. No upstream: `git push -u origin <branch>`.
- **Sync:** pull, then push. Open question for a diverged branch: the row `⇅` opens `03` so the person chooses, while the toolbar `Sync` has no designed behaviour for that case yet. I would route it to `03` too, since an automatic merge can end in a conflict.
- **Force-push:** `git push --force-with-lease`, never plain `--force`.
- **Non-current branch:** fast-forward without switching: `git fetch origin main:main`.

### Branch menu

| Item | Git | Notes |
|---|---|---|
| `Switch` | `git switch <branch>` | Remote-only: creates a tracking branch. A dirty tree that blocks the switch needs a state, see gaps |
| `New branch…` | `git switch -c <name> <start>` or `git branch` | `Switch to it now` picks which |
| `Merge into current` | `git merge <branch>` | Conflict goes to the merge screens |
| `Rebase current onto this` | `git rebase <branch>` | Conflict screens need rebase wording, see gaps |
| `Rename…` | `git branch -m old new` | With origin: `git push origin -u new`, then `git push origin --delete old` |
| `Delete…` | `git branch -d`, or `-D` after the warning | Remember the sha for `Undo`: `git branch <name> <sha>` |
| `Delete on origin…` | `git push origin --delete <branch>` | No `Undo` |
| `Pin` | none | Githor's own state, in `workspaceState` |

Disabled, with the reason shown: `Delete` on the current branch and on the default branch.

Commits only on this branch, for the warning in `34`: `git log <branch> --not --exclude=<branch> --branches --remotes`. `--exclude` takes the name as `--branches` sees it, without `refs/heads/`; with the prefix it excludes nothing. Commits that would leave origin with `Also delete origin/<branch>`: `git log origin/<branch> --not --exclude=<branch> --branches --exclude=origin/<branch> --remotes`. Both are tested in `test/branch-ops.test.ts`.

### Delete all merged branches

- List: `git branch --merged <target>`, with `main` as the default target.
- Leave out the target, the current branch, and branches checked out in another worktree.
- **Squash merges and rebase merges do not count as merged in git**, so those branches will not appear. The dialog's wording says "fully merged", which stays true, but people may expect more.
- `Also delete them on origin` is off by default. Its text names which branches are affected.
- `Undo` restores local branches from remembered shas.

### Commit file list: sections and grouping

`04` draws a flat list. `49`–`52` replace its file list; the composer and the diff stay as they are.

- **Sections.** `Changes` holds tracked files, `Unversioned Files` the untracked ones, each with a count. From `git status --porcelain=v2 -z`: entries `1` and `2` (renames) go to `Changes`, entries `?` to `Unversioned Files`, `!` (ignored) to neither. Unmerged entries `u` belong to the conflict screens, not here.
- **Status letters.** `A` added, `M` modified, `D` deleted, `R` renamed in `Changes`; `U` in `Unversioned Files`.
- **Ticking.** A ticked file goes into the commit. Unversioned files start unticked, so a stray file never slips in; ticking one means `git add` at commit time. A section, directory or repository row has a three-state box: all, some (the dash), none. Ticking it ticks everything under it.
- **Group by.** The icon button before `Stash…` opens a menu with `Directory` and `Repository`. Both can be on at once, repository first, then directory. `Ungroup` turns both off. The button is highlighted while a grouping is on. The choice is Githor's own state, in `workspaceState`, like `Pin`.
- **Directory** (`51`): a row per directory with a folder icon and a count, files indented under it without their directory. One level per directory path, not one per path segment: `src/core` is one row. Each section is grouped on its own.
- **Repository** (`52`): a row per repository with its name, count and branch, for a workspace with several repositories. One message is committed in each repository that has ticked files, on that repository's current branch, and `Commit to` says how many. This needs the model to hold every open repository, not only the active one; until then `Repository` is hidden when one repository is open.
- **Counts.** `3 of 4 files in this commit` counts ticked files across sections and repositories.
- Collapsing a section or directory with its chevron is drawn expanded only; collapsed rows show the same row with the chevron pointing right.

### Conflicts

Merge and squash share one flow: find conflicts, show a side-by-side, resolve, continue or abort.

- **Find:** `git status --porcelain=v2` or `git ls-files -u`. In progress: `.git/MERGE_HEAD`, `.git/rebase-merge`.
- **Sides:** `git show :2:<path>` and `git show :3:<path>`.
- **Stage meaning flips between merge and rebase.** In a merge `:2` is your branch and `:3` is the incoming one. In a rebase `:2` is what you are rebasing onto and `:3` is your commit being replayed. Map labels to stages per operation, never to "ours" and "theirs" directly.
- **Resolve:** apply the choice to the file, then `git add <path>`.
- **Accept both:** both sides in order, left first. It can produce broken code, so the result block is always shown.
- **Continue:** `git merge --continue` or `git rebase --continue`, with `GIT_EDITOR=true` since nobody can answer an editor.
- **Abort:** `git merge --abort` or `git rebase --abort`.
- **Merge on another branch** (`03` works on a selected branch): switch first. Status bar and `On {branch}` then show that branch.

### Squash

- Newest commits, adjacent to HEAD: `git reset --soft <base>`, then commit.
- Older commits: a scripted rebase (`GIT_SEQUENCE_EDITOR`), which is what can stop at a conflict (`16`).
- `Undo`: remember the old HEAD, then `git reset --keep <sha>`.
- Warn when the commits are already on origin (`13`), since the branch will then need a force-push.

### Accounts

**Needs a spike before step 2.** The screens fix what people see, not how sign-in works.

- **Identity:** `git config --local user.name` and `user.email`, or `git -c user.name=... commit` per call.
- **Credentials, by account type:**
  - Browser sign-in: `vscode.authentication.getSession`. Check whether the GitHub provider's multi-account support works on `engines.vscode` `^1.85`.
  - Token: `context.secrets`, never settings or `globalState`.
  - SSH: `core.sshCommand` per repository.
- **Passing a token to git:** open question, since `GIT_TERMINAL_PROMPT=0` blocks prompts. A likely route is a credential helper or askpass per call.
- **Picking the account:** the repository's own choice wins, then the first rule matching the remote URL, then the last rule. Rules live in settings, the repository's choice in `workspaceState`.
- **Check before commit** (`48`): warn when the active account differs from what the rules pick.
- **Push rejected** (`48`): recognise 403 and offer an account that has access. How to know which one has access is also part of the spike.

## Known gaps in the design

Not designed yet:

- Switching when uncommitted changes block it
- Rebase conflict wording, for `Rebase on remote` on `03` and `Rebase current onto this`
- A confirmation for `Merge into current` and `Rebase current onto this`, which currently run directly
- Several conflicts or several files, only one of each is drawn
- `Cherry-pick 2`, which has a button and no screen
- Pull rejected because of local changes
- Collapsed state of a section or directory in the commit list (`49`–`52` show them expanded)
- A commit across repositories where one repository fails, such as a hook rejecting it
- Long branch names in `Accept {branch}` buttons; I would truncate in the middle and show the full name in a tooltip

Prototype gaps, not product gaps:

- Links across pages do not exist: tabs, `Push` on `01`, `Sync`, the account button, and buttons that end on another page, such as `Create branch` or `Cancel` on `43`.
- Clicking a row on `01` stands in for Cmd-click selection, and clicking line 15 or 24 stands in for typing.

## Design status (2026-11-05)

- **Dark theme:** ready. A sample from each page was checked by eye, plus an automatic check for broken rows and text widths on every frame. Some frames were checked only automatically.
- **Light and high-contrast themes:** not verified. Do not toggle themes in this file through the plugin: it damaged text widths and syntax colours on many frames. Check them on a small copy. The implementation reads colours from tokens, so real checks belong in VS Code anyway.
- **Prototype links:** hotspots need a nearly transparent fill to be clickable, and they have one. Two links were clicked in the viewer, both on the Merge page. The rest have been read from the file only.
- **Viewer counter:** it shows more boards than a page has screens (`1 / 47` on Merge, which has 9). The cause is unknown.
- **Saved versions in Penpot:** `Before Sync badge cleanup`, `Before splitting Screens into pages`, `Pages split, repaired, hotspots clickable`.
