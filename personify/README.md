# Personify

One panel to make VS Code yours: hotkeys, sidebar / editor / terminal look, and syntax colors for JS/TS/Node.js and Go.

Open it with **Personify: Open** (Command Palette) or the **🎨 Personify** button in the status bar.

## Tabs

- **Hotkeys**: search by command, key or `when`, or press keys to search by shortcut. Filters: changed by me, conflicts, removed, commands without a shortcut. Record shortcuts (chords too), edit/remove defaults, restore them, reset a command. Conflicts are flagged while recording.
- **Appearance**: Sidebar, Editor and Terminal sections with colors (with alpha), font family / size / weight, line height, letter spacing, cursor, ANSI palette and more. Every value can be reset on its own or per section.
- **Syntax colors**: JS/TS (including Node.js globals and JSX) and Go, about 90 token kinds grouped as keywords, literals, names, types, operators and comments. Each token gets a color plus bold / italic / underline / strikethrough, with a live preview (click a token to jump to its setting). **Custom scopes** styles any TextMate scope; **Inspect token under cursor** shows you which scope to use.
- **Profiles & backup**: export/import a JSON profile, revert everything changed in this session, reset all Personify customizations.

## Where settings go

Everything is written to the regular VS Code JSON files, nothing hidden:

| What | File | Key |
| --- | --- | --- |
| UI colors | `settings.json` | `workbench.colorCustomizations` |
| Syntax colors | `settings.json` | `editor.tokenColorCustomizations.textMateRules` (rules named `personify:…`) + `editor.semanticTokenColorCustomizations.rules` |
| Fonts etc. | `settings.json` | `editor.fontSize`, `terminal.integrated.fontFamily`, … |
| Hotkeys | `keybindings.json` | standard entries; removing a default adds a `-command` entry |

- **Save to** chooses user settings or the workspace's `.vscode/settings.json`.
- **Apply to → Current theme** nests values under `"[Theme name]"`.
- `keybindings.json` is edited in place with comments kept; a copy `keybindings.json.personify-backup` is saved before the first change of each session.
- Settings you wrote by hand are never removed: Personify only touches its own rules and the keys it manages.

## Known limits

- VS Code has no separate font family/size for the sidebar; only the window zoom level (offered in the Sidebar section).
- Go token scopes follow VS Code's built-in Go grammar. Semantic colors for Go need `"gopls": { "ui.semanticTokens": true }`.
- With a non-default VS Code profile, set `personify.keybindingsPath` to that profile's `keybindings.json`.

## Develop

Open this folder in VS Code and press F5. Package: `npx @vscode/vsce package`, then install the `.vsix`.
