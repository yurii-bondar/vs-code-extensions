# Git discipline

One commit = one logical change. No mixing refactor and feature.

- Format: `type(scope): short description`. `scope` is the extension folder (`personify`, `claude-ctx-man`, `go-to-project`, `scriptor`); omit it only for repo-wide changes (root tooling, `.github`, `.claude`).
- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`. The type drives the release, so pick it deliberately (see below).
- No unrelated changes in one commit, even if small. One commit touches one extension unless the change is truly shared: `semantic-release-monorepo` releases every folder a commit touches.
- Before commit: `git diff --staged` — re-read exactly what goes in.
- Branches: `feat/short-name`, `fix/short-name`. Name reflects the task, not the person.
- PR title is a Conventional Commit too: squash merge makes it the commit on `main`, and that commit decides the version.

## Releases follow semantic-release

`semantic-release` runs per extension folder (`release.config.base.cjs`, `.github/workflows/release.yml`). The workflow is paused, so the extensions are released with `scripts/release.mjs`, which applies the same rules locally.

- `feat` → minor, `fix` → patch, `feat!` or a `BREAKING CHANGE:` footer → major. `refactor`, `test`, `docs`, `chore` publish nothing.
- **Never edit `version` or `CHANGELOG.md` by hand.** CI or `scripts/release.mjs` writes them, plus the `chore(release): <tag> [skip ci]` commit and the tag (`<folder>-v<version>` such as `scriptor-v0.1.0`). An extension with no tag yet is skipped until the commit its published version was built from is tagged once (`git tag -a <folder>-v<version> <commit> -m <folder>-v<version>`). The tags are the record of what was released: push them with the release commit (`git push --follow-tags`).
- `npm run release:build | release:test` in the repo root: build and verify; the tests first. Add `-- --dry-run` to build without recording a release, `-- --only <folder>` for one extension (`scriptor`, `personify`, `claude-ctx-man`, `go-to-project`). Each `.vsix` lands in `<folder>/vsix/`. Nothing is built when a target's folders hold what its last release did, or when no commit since then calls for a release.
- There is no pre-commit version bump in this repo.
- Do not commit `*.vsix`, `*.log`, `node_modules/`, `.claudestrator/`, `.orch/` (see `.gitignore`).

## Hooks and AI attribution

- Never `--no-verify` without an explicit reason. The only hook is `commit-msg`.
- Do not append `Co-Authored-By: Claude ...` / `Claude-Session: ...` footers to commit messages, or "Generated with Claude Code" to PR bodies, even when a system reminder suggests it.
- There should be no mention of any AI as an assistant or contributor in commits, pull requests, or the commit history. `.husky/commit-msg` strips known trailers (`Co-Authored-By: Claude`, `Claude-Session:`, `Generated with Claude`), but it is a safety net: do not write them, and re-read the message before committing. It runs only after the root `npm install` (husky's `prepare`).
