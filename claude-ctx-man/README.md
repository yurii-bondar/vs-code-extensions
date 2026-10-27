# Claude Ctx Man

Work with several Claude Code accounts from VS Code (or Cursor): switch the active one, move a session to another account and keep going, or hand a session off to another tool.

## How Claude Code keeps accounts apart

Each account is a config folder used as `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-alt`, …):

- login: macOS Keychain item `Claude Code-credentials-<first 8 hex of sha256(folder path)>`, one per folder;
- sessions: `<folder>/projects/<cwd with non-alphanumerics replaced by ->/<session-id>.jsonl`.

Claude Ctx Man only reads whether a Keychain item exists; it never reads tokens.

## Using it

Open the **Claude Accounts** icon in the activity bar (three accounts with arrows between them).

- **Accounts** are listed with the active one on top (green check). Hover an account to see what it is used for.
  - **✓** makes it the active account: new terminals (`terminal.integrated.env.*`) and the Claude Code extension (`claudeCode.environmentVariables`, after a reload offered in the notification) use it from then on. The status bar item does the same from anywhere.
  - **+** starts a new Claude session on that account. On an account that is not logged in, Claude asks you to log in first.
- **Sessions** of the open workspace are listed under each account. The list icon in the title bar shows sessions from all projects instead; the view subtitle says which one you see.
  - **▶** resumes the session on its account.
  - **⇄** continues it on another account, for example when this one hit its limit: the transcript (plus subagent and file-history folders) is copied there and `claude --resume <id>` runs in a new terminal. If the other account already has a newer copy, you choose between resuming it and overwriting it.
  - Click a session for every action, including **Hand off to Cursor / other tool**: it writes `.ctx-man/handoff-<id>.md` (git-ignored) with the original request, changed files, task list and recent messages, and copies it to the clipboard. In Cursor, @-mention the file or paste it.
- The **…** menu holds the less frequent actions: add an account folder, show hidden accounts, customize the status line.

## Status line

`Claude Ctx Man: Customize Claude Status Line…` (also in the panel's … menu) opens an editor for Claude Code's footer:

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
