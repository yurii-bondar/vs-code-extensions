# Claude Ctx Man

Work with several Claude Code accounts from VS Code (or Cursor): switch the active one, move a session to another account and keep going, or hand a session off to another tool.

## How Claude Code keeps accounts apart

Each account is a config folder used as `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-alt`, …):

- login: macOS Keychain item `Claude Code-credentials-<first 8 hex of sha256(folder path)>`, one per folder;
- sessions: `<folder>/projects/<cwd with non-alphanumerics replaced by ->/<session-id>.jsonl`.

Claude Ctx Man only reads whether a Keychain item exists; it never reads tokens.

## Using it

Open the **Claude Accounts** icon in the activity bar (three accounts with arrows between them).

- Each **account** is a card with an avatar in its own color, the login state and the number of sessions; the active one is on top (green). Cards open and close, and the panel remembers which.
  - **Use** makes it the active account: new terminals (`terminal.integrated.env.*`) and the Claude Code extension (`claudeCode.environmentVariables`, after a reload offered in the notification) use it from then on. The status bar item does the same from anywhere.
  - **+** starts a new Claude session on that account. On an account that is not logged in, Claude asks you to log in first. Point at a card to get the button that hides the account.
- **Sessions** of the open workspace are listed under each card. **This workspace / All projects** at the top switches to the sessions of every project. The search box (press `/`) looks through titles, branches, folders and the last prompt.
  - **▶** on a row resumes the session on its account. Large sessions are marked, because moving them costs the other account's limits.
  - Click a row to open it: it shows the last prompt and every action. **Another account…** continues it elsewhere, for example when this one hit its limit: the transcript (plus subagent and file-history folders) is copied there and `claude --resume <id>` runs in a new terminal. If the other account already has a newer copy, you choose between resuming it and overwriting it. **Hand off** writes `.ctx-man/handoff-<id>.md` (git-ignored) with the original request, changed files, task list and recent messages, and copies it to the clipboard. In Cursor, @-mention the file or paste it.
- The buttons at the bottom open the status line editor, **Set Up AI Config Files…** (the button at the bottom of the panel, or the command palette) opens a page for preparing a project for AI assistants. Pick a setup, see the files and folders it would create, and untick the ones you do not want. Nothing is written until you press **Create**.

- **Claude Code only**: `CLAUDE.md`, `.claude/rules/`, `.claude/skills/`.
- **Several AI tools**: the real folders are `.aiassistant/rules` and `.aiassistant/skills`, and `CLAUDE.md` is the main file. For the tools you pick (Claude Code, Cursor, Codex and other `AGENTS.md` readers), `.claude/` and `.cursor/` get `rules` and `skills` as relative symlinks to them, and `AGENTS.md` links to `CLAUDE.md`.

Each row is marked **New**, **Already there** or **Different one exists**. Nothing that exists is overwritten; a different file or folder is left as it is. A link needs what it points at: if you untick `CLAUDE.md`, the `AGENTS.md` link is left out too, unless `CLAUDE.md` is already there. On Windows, folders are linked with junctions; the `AGENTS.md` link may need Developer Mode.

## Status line

`Claude Ctx Man: Customize Claude Status Line…` (also in the panel's … menu) opens an editor for Claude Code's footer. A live preview, drawn like a terminal, stays at the top while you work; everything you change is saved at once and shows up on the next render. Four tabs:

- **Layout**: start from a preset (Classic, Enhanced, Compact, Minimal), then drag segments onto up to 3 lines or click one to edit it. Segments: account, project, git (ahead/behind, changed files), model, effort, context, tokens, 5-hour and weekly limits (with time to reset), cost, lines changed, session time, clock, output style, version, custom text. Per segment: icon, label, color (palette or any hex), bold, attach to previous; percentages as `77%`, a bar `▰▰▰▱`, or both.
- **Style**: the separator, the bar width, and the warn and danger levels and colors for segments colored by usage.
- **Names**: a name and a color per account, matched by email.
- **Install**: tick the accounts, then **Apply**. The header shows whether it is installed yet.

The preview uses your latest real session (or a chosen account's), or sample data before you have one.

**Install** writes `statusLine` into each selected account's `settings.json` (previous value remembered for **Restore**, plus `settings.json.ctx-man-backup`). The renderer is `~/.ctx-man/statusline.js` (Node) and reads `~/.ctx-man/statusline.json` on every render, so later edits apply without reinstalling. Token totals are read incrementally from the transcript. Compatibility options keep `/tmp/claude_state` (tmux), per-session snapshots in `<account>/statusline/`, and the `~/.claude/statusline_disabled` toggle working.

## Notes

- Moving a session re-sends its whole context on the new account, so a long session uses a lot of that account's limits. Run `/compact` first.
- Cursor's own chat history (SQLite, undocumented) is not read or written. Going from Cursor back to Claude Code means pasting context manually. Claude Code itself works inside Cursor with the same config folders, so everything here works there too.
- Using several accounts is fine; check Anthropic's terms before rotating accounts specifically to get around usage limits.

## Settings

`ctxMan.accounts` (extra folders / custom labels), `ctxMan.autoDiscover`, `ctxMan.claudeCommand`, `ctxMan.syncTerminalEnv`, `ctxMan.syncClaudeExtension`, `ctxMan.switchActiveOnContinue`, `ctxMan.maxSessionsPerAccount`, `ctxMan.handoffDir`, `ctxMan.handoffMessages`.

## Develop

TypeScript: the host code is `extension.ts` and `src/`, the status line renderer `statusline/render.ts`, the editor page `media/statusline.ts`, tests `test/`.

```
npm install
npm run build        # tsc for the host and for the page → dist/
npm run typecheck && npm run lint
npm test             # builds, then node --test dist/test/*.test.js
```

Open this folder in VS Code and press F5 (build first). Package: `npm run package`, then install the `.vsix`.

`statusline/render.ts` is copied (compiled) to `~/.ctx-man/statusline.js` and run on its own by Claude Code, so it must stay one file that loads only Node's own modules.
