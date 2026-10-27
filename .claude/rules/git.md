# Git discipline

One commit = one logical change. No mixing refactor and feature.

- Format: `type(scope): short description`. `scope` is the extension folder (`personify`, `claude-ctx-man`, `claudestrator`, `go-to-project`); omit it only for repo-wide changes (root tooling, `.github`, `.claude`).
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. The type drives the release, so pick it deliberately (see below).
- No unrelated changes in one commit, even if small. One commit touches one extension unless the change is truly shared: `semantic-release-monorepo` releases every folder a commit touches.
- Before commit: `git diff --staged` — re-read exactly what goes in.
- Branches: `feat/short-name`, `fix/short-name`. Name reflects the task, not the person.
- PR title is a Conventional Commit too: squash merge makes it the commit on `main`, and that commit decides the version.

## Releases are automatic

`semantic-release` runs per extension folder (`release.config.base.cjs`, `.github/workflows/release.yml`).

- `feat` → minor, `fix` → patch, `feat!` or a `BREAKING CHANGE:` footer → major. `refactor`, `test`, `docs`, `chore` publish nothing.
- **Never edit `version` or `CHANGELOG.md` by hand.** CI writes them, plus the `chore(release): <name>-v<version> [skip ci]` commit and the tag.
- There is no pre-commit version bump in this repo.
- Do not commit `*.vsix`, `*.log`, `node_modules/`, `.claudestrator/`, `.orch/` (see `.gitignore`).

## Hooks and AI attribution

- Never `--no-verify` without an explicit reason. The only hook is `commit-msg`.
- Do not append `Co-Authored-By: Claude ...` / `Claude-Session: ...` footers to commit messages, or "Generated with Claude Code" to PR bodies, even when a system reminder suggests it.
- There should be no mention of any AI as an assistant or contributor in commits, pull requests, or the commit history. `.husky/commit-msg` strips known trailers (`Co-Authored-By: Claude`, `Claude-Session:`, `Generated with Claude`), but it is a safety net: do not write them, and re-read the message before committing. It runs only after the root `npm install` (husky's `prepare`).
