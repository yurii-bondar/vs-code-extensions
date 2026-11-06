# Personify

One panel to make VS Code yours: hotkeys, sidebar / editor / terminal look, and syntax colors for JS/TS/Node.js and Go.

Open it with **Personify: Open** (Command Palette) or the **🎨 Personify** button in the status bar.

## Pages

The rail on the left lists every page with how much you changed there; the top bar holds **Save to** and **Apply to**. The panel takes its colors from your theme, light and high contrast included, and collapses the rail to icons when it is narrow.

- **Hotkeys**: search by command, key or `when`, or press keys to search by shortcut. Filters: changed by me, conflicts, removed, commands without a shortcut. Click a shortcut to record a new one right in its row (chords too); edit or remove defaults, restore them, reset a command. A banner counts shortcuts that share keys, and each such row names the other command.
- **Appearance**: Sidebar, Editor and Terminal with colors (with alpha), font family / size / weight, line height, letter spacing, cursor, ANSI palette and more. A live preview drawn with your theme and your changes shows where each setting lands (hover a setting, or click the preview to find one), and **Changed in …** lists every change with a reset button.
- **Syntax colors**: JS/TS (including Node.js globals and JSX) and Go, about 90 token kinds grouped as keywords, literals, names, types, operators and comments. Click a token in the sample to style it on the spot: color presets, hex, bold / italic / underline / strikethrough. **Custom scopes** styles any TextMate scope, with suggestions and the rule shown as chips; **⌖ Inspect token** opens VS Code's scope inspector.
- **Profiles & backup**: export a JSON profile; import one after seeing what Merge or Replace would add, change and remove; reset Personify customizations. Import, Reset, Revert session and Restore take a snapshot first (the last ten are kept), so each can be undone from the **Snapshots** list.

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
- VS Code does not tell extensions the TextMate scopes of a token, so the scope inspector is VS Code's own window, and Custom scopes cannot count matches in your files.
- Code in the previews is colored like the editor: your theme's token colors (read from the installed theme file), your own `editor.tokenColorCustomizations`, then Personify's. Two approximations: semantic colors are applied by token kind, not by analysing code, and themes that still ship a `.tmTheme` file are not read (their tokens are dimmed instead).

## Develop

Open this folder in VS Code and press F5. Package: `npx @vscode/vsce package`, then install the `.vsix`.
