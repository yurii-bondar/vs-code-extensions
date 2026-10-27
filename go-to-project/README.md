# Go To Project

Switch between VS Code windows the way JetBrains IDEs do: one shortcut, a searchable list of your open projects with their git branches, and Enter to jump back to the one you came from.

## Commands

| Command | macOS | Windows / Linux | What it does |
| --- | --- | --- | --- |
| **Go To Project** | `cmd+alt+p` | `ctrl+alt+p` | The open project windows, the one you came from first. The last row, *Recent projects…*, opens the recent list and keeps what you typed. |
| **Go To Recent Project** | `cmd+alt+e` | `ctrl+alt+e` | Recent projects that are not open. Deleted folders, the Trash and temp folders are left out. |
| **Go To Last Project** | — | — | Jump straight back to the window you were in before this one. |

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

## Notes

- Windows find each other through a small file in the extension's global storage; nothing leaves your machine.
- The recent list comes from an internal VS Code command, as there is no public API for it. If a VS Code update removes it, **Go To Recent Project** opens VS Code's own *Open Recent* instead.
