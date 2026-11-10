# Go To Project

Switch between VS Code windows the way JetBrains IDEs do: one shortcut, a searchable list of your open projects with their git branches, and Enter to jump back to the one you came from.

## Commands

| Command | macOS | Windows / Linux | What it does |
| --- | --- | --- | --- |
| **Go To Project** | `cmd+alt+p` | `ctrl+alt+p` | The open project windows, the one you came from first. The last row, *Recent projects…*, opens the recent list and keeps what you typed. |
| **Go To Recent Project** | `cmd+alt+e` | `ctrl+alt+e` | Recent projects that are not open. Deleted folders, the Trash and temp folders are left out. |
| **Go To Last Project** | — | — | Jump straight back to the window you were in before this one. |
| **Go To Project in This Directory** | `cmd+r` | `ctrl+alt+r` | The projects next to this one: every folder and `.code-workspace` file in the folder this window's project lives in. Hidden folders are left out. |
| **Go To Project in Directory 1…9** | your key | your key | The projects in a folder from `goToProject.directories`. |
| **Go To Project: Add Directory…** | — | — | Pick a folder, add it to `goToProject.directories`, and give its command a key. |

## Directories

Besides the folder of the current project you can keep up to nine folders of projects one key away, say `~/work` and `~/oss`. **Go To Project: Add Directory…** adds a folder as the next entry *n*, then opens Keyboard Shortcuts at **Go To Project in Directory *n*** so you can press its key there. Or write the list yourself:

```json
"goToProject.directories": ["~/work", "~/oss"]
```

with the keys in `keybindings.json`:

```json
[
  { "key": "cmd+alt+1", "command": "goToProject.directory1" },
  { "key": "cmd+alt+2", "command": "goToProject.directory2" }
]
```

A key belongs to the position in the list, so removing an entry moves the ones after it to the keys before.

Each row looks like a JetBrains project: an icon with the project's initials, the name and git branch (worktrees are marked), the path below. Search matches name, branch and path. Multi-root `.code-workspace` files are listed like folders.

## Shortcuts

The default keys do not replace any VS Code shortcut. For the JetBrains feel, put the short ones in your own `keybindings.json` (**Preferences: Open Keyboard Shortcuts (JSON)**); your bindings win over the extension's:

```json
[
  { "key": "cmd+w", "command": "goToProject.open" },
  { "key": "cmd+e", "command": "goToProject.recent" },
  { "key": "cmd+alt+[", "command": "goToProject.last" }
]
```

`cmd+w` then no longer closes editors and `cmd+e` no longer does *Use Selection for Find*.

The extension always runs on your machine, also in Remote SSH, WSL and Dev Container windows, so it sees every open window. Remote projects show no git branch.

VS Code shows these lists at the top of the window like every quick pick; drag one by its top edge to move it and VS Code keeps the position (the Command Palette moves with it).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `goToProject.includeRecent` | `true` | Show the *Recent projects…* row at the end of the Go To Project list. |
| `goToProject.showBranch` | `true` | Show the current git branch next to each local project. |
| `goToProject.directories` | `[]` | Folders of projects for **Go To Project in Directory 1…9**, in that order; `~` is your home folder. |

## Notes

- Windows find each other through a small file in the extension's global storage; nothing leaves your machine.
- The recent list comes from an internal VS Code command, as there is no public API for it. If a VS Code update removes it, **Go To Recent Project** opens VS Code's own *Open Recent* instead.
