# Scriptor

A launchpad for your scripts and commands. Keep any `.sh`, `.js`, `.py` (and more), or a command like `npm run dev` in a project folder, in one place, group them, and run each one in a terminal with a click, the same as if you had typed it yourself.

## Using it

- **Open Scriptor**: the activity-bar icon, or the *Scriptor: Open Scriptor* command. The dashboard shows your scripts as cards, grouped, with a search box (`/` focuses it).
- **Add script**: choose *Script file* or *Command* at the top of the dialog.
  - *Script file*: pick a file with *Browse…* or type its path (`~` works). The name is optional and defaults to the file name.
  - *Command*: type any command line (`npm run dev`, `make test`, `docker compose up -d`) and choose the folder it runs in. The name defaults to the command.

  Choose a group if you want one.
- **New group**: a name and a color. *Run all* on a group opens every script of it, each in its own terminal.
- **Run**: opens a terminal named after the script, in the script's folder (or the command's folder), and types the command. Each run is a new terminal, so a running server is never interrupted.
- **Sidebar**: the *Scripts* view lists the same scripts with an inline ▶. Right-click for edit, open the file, reveal, remove.
- **Run Script…** in the Command Palette runs any script from a quick pick.

Removing a script or a group only removes it from Scriptor; files are never touched. A script whose file is gone, or a command whose folder is gone, is marked *Not found*.

## How a script is run

A command is typed into the terminal exactly as you wrote it, in its folder. For a script file, the interpreter comes from the file extension:

| Extension | Command |
|---|---|
| `.sh` `.bash` / `.zsh` | `bash` / `zsh` |
| `.js` `.mjs` `.cjs` | `node` |
| `.ts` | `npx tsx` |
| `.py` | `python3` (`python` on Windows) |
| `.rb` `.php` `.pl` `.lua` `.go` | `ruby` `php` `perl` `lua` `go run` |
| `.ps1` | `pwsh -File` (`powershell` on Windows) |
| `.bat` `.cmd` and anything else | the file itself (needs a shebang and the executable bit on macOS and Linux) |

Under *Advanced* a script can have its own interpreter (e.g. `/venv/bin/python -u`; quote it yourself if its path has spaces), arguments, and working directory. The path is quoted for your terminal's shell (bash/zsh, PowerShell, cmd).

Scripts and groups are stored in VS Code's global state on this machine; they are not synced, because the paths are machine-specific.
