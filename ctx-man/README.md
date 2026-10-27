# Ctx Man

Work with several Claude Code accounts from VS Code (or Cursor): switch the active one, move a session to another account and keep going, or hand a session off to another tool.

## How Claude Code keeps accounts apart

Each account is a config folder used as `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-alt`, …):

- login: macOS Keychain item `Claude Code-credentials-<first 8 hex of sha256(folder path)>`, one per folder;
- sessions: `<folder>/projects/<cwd with non-alphanumerics replaced by ->/<session-id>.jsonl`.

Ctx Man only reads whether a Keychain item exists; it never reads tokens.

## Features

- **Accounts & Sessions view** (activity bar): every `~/.claude` / `~/.claude-*` folder with its email, login state and the sessions of the open workspace. Toggle to see all projects.
- **Switch account** (status bar or `Ctx Man: Switch Claude Account`): sets `CLAUDE_CONFIG_DIR` for new terminals (`terminal.integrated.env.*`) and for the Claude Code extension (`claudeCode.environmentVariables`; it needs a restart, offered in the notification).
- **Continue Session on Another Account**: copies the transcript (plus subagent and file-history folders) into the other account and runs `claude --resume <id>` there in a new terminal. If the target already has a newer copy, you choose between resuming it and overwriting it.
- **Export Handoff**: writes `.ctx-man/handoff-<id>.md` (git-ignored) with the original request, changed files, task list and recent messages, and copies it to the clipboard. In Cursor, @-mention the file or paste it.
- **Resume Session**, **Open Claude Terminal**, **Copy Session ID**, **Reveal Transcript File**.

## Status line

`Ctx Man: Configure Claude Status Line` (or the pulse icon in the panel) opens an editor for Claude Code's footer:

- drag segments onto up to 3 lines: account, project, git (ahead/behind, changed files), model, effort, context, tokens, 5-hour and weekly limits (with time to reset), cost, lines changed, session time, clock, output style, version, custom text;
- per segment: icon, label, color (palette or any hex), bold, attach to previous; percentages as `77%`, a bar `▰▰▰▱`, or both, optionally colored by usage (warn/danger thresholds);
- names and colors per account (matched by email), live preview with your latest real session data, presets.

**Install** writes `statusLine` into each selected account's `settings.json` (previous value remembered for **Restore**, plus `settings.json.ctx-man-backup`). The renderer is `~/.ctx-man/statusline.js` (Node) and reads `~/.ctx-man/statusline.json` on every render, so later edits apply without reinstalling. Token totals are read incrementally from the transcript. Compatibility options keep `/tmp/claude_state` (tmux), per-session snapshots in `<account>/statusline/`, and the `~/.claude/statusline_disabled` toggle working.

## Notes

- Moving a session re-sends its whole context on the new account, so a long session uses a lot of that account's limits. Run `/compact` first.
- Cursor's own chat history (SQLite, undocumented) is not read or written. Going from Cursor back to Claude Code means pasting context manually. Claude Code itself works inside Cursor with the same config folders, so everything here works there too.
- Using several accounts is fine; check Anthropic's terms before rotating accounts specifically to get around usage limits.

## Settings

`ctxMan.accounts` (extra folders / custom labels), `ctxMan.autoDiscover`, `ctxMan.claudeCommand`, `ctxMan.syncTerminalEnv`, `ctxMan.syncClaudeExtension`, `ctxMan.switchActiveOnContinue`, `ctxMan.maxSessionsPerAccount`, `ctxMan.handoffDir`, `ctxMan.handoffMessages`.

## Develop

Open this folder in VS Code and press F5. Package: `npx @vscode/vsce package`, then install the `.vsix`.
