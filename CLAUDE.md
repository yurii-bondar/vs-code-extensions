# vs-code-extensions

Monorepo of five VS Code extensions, each a self-contained folder with its own `package.json`, `release.config.cjs`, README and LICENSE:

| Folder | Extension | Notes |
|---|---|---|
| `personify/` | Personify | settings panel (hotkeys, colors, fonts, syntax); webview in `media/main.js` |
| `claude-ctx-man/` | Claude Ctx Man | accounts/sessions tree, statusline (`src/`, `statusline/`) |
| `claudestrator/` | Claudestrator | orchestrator; engine in `src/core/`, hook in `hook/`, tests in `test/` |
| `go-to-project/` | Go to Project | `extension.js` + `lib.js`, tests in `test/` |
| `scriptor/` | Scriptor | script launcher: groups of `.sh`/`.js`/`.py` scripts run in a terminal; pure logic in `src/core/`, dashboard webview in `media/` |

The root `package.json` is release tooling only (semantic-release + `semantic-release-monorepo`). It has no app code.

**Current state.** `claudestrator/`, `claude-ctx-man/` and `scriptor/` are TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`): host code in `extension.ts` and `src/`, webview scripts in `media/*.ts` (plain scripts with their own `tsconfig.webview.json`), tests in `test/`. Build output goes to `dist/` (git-ignored, `main` is `./dist/extension.js`). In each: `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (builds, then `node --test dist/test/*.test.js`). `personify/` and `go-to-project/` are still plain CommonJS JavaScript with `node --test test/*.test.js`.

`claude-ctx-man/statusline/render.ts` is special: Install copies its compiled `dist/statusline/render.js` to `~/.ctx-man/statusline.js`, where Claude Code runs it alone. It must stay one self-contained file that loads only Node's own modules; its imports from `statusline/types.ts` are `import type` (erased).

## Rules and skills

Everything is adapted to this repo and lives in `.claude/`:

| File | Covers |
|---|---|
| `rules/git.md` | commit format with extension scope, semantic-release behaviour (no manual version/CHANGELOG edits), no AI attribution |
| `rules/typescript.md` | strict tsconfig, no `any`, boundaries of this repo (`~/.claude*` files, hook payloads, webview messages, VS Code config), branded IDs |
| `rules/principles.md` | SOLID/KISS/DRY/YAGNI applied to extensions: thin `extension.js`, injectable fs/git/clock seams, disposables |
| `skills/ts-performance` | extension-host hot paths: cheap activation, no `*Sync` in the host, streaming `.jsonl`, debounced watchers, cache by mtime, webview messaging |

`principles.md` and `typescript.md` apply to new `.ts`; existing `.js` follows them in spirit until migrated. `ts-performance` is loaded only for the hot paths listed in its description, and readability wins elsewhere.

The only git hook is husky's `commit-msg` (`.husky/commit-msg`), which strips AI-attribution trailers from commit messages. The root `npm install` activates it through the `prepare` script (`core.hooksPath` becomes `.husky/_`), so run it once after cloning. There is no pre-commit hook and no pre-commit version bump. CI's `pr-title` check is paused (`workflow_dispatch` only), so verify PR titles by hand.

## Writing code today (JavaScript)

Until the migration, hold new `.js` to the intent of `typescript.md` and `principles.md`:
- Match the surrounding style (CommonJS, existing naming and comment density).
- Validate and normalise external data at the boundary: `settings.json`, `~/.claude` files, hook payloads, `postMessage` messages. Downstream code should see one shape.
- Functions with 3+ positional parameters take an options object.
- Pure logic goes in separate modules (`lib.js`, `src/core/`) so it can be tested with `node --test` without VS Code. Keep `extension.js` thin.
- Add a test in the extension's `test/` for logic changes.
- Delete dead code. No flags or parameters "for the future".

## TypeScript migration plan

Rules to apply from the first TS commit:

1. **Per-extension migration**, one extension per PR, matching the release model. Order: `go-to-project` (smallest, has tests) → `personify` → `claude-ctx-man` → `claudestrator`. Done so far: `claudestrator`, `claude-ctx-man`.
2. **`tsconfig`**: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (required by `typescript.md`), `noImplicitReturns`, target matching the VS Code engine's Node (check `engines.vscode`). Prefer one shared `tsconfig.base.json` at the root that each extension extends.
3. **Types**: `@types/vscode` pinned to the same range as `engines.vscode`. `@types/node`.
4. **No `any`.** Type JSON from disk, hook payloads and webview messages as `unknown` and narrow them at the boundary. Webview messages are a discriminated union with an exhaustive `switch` and a `never` default.
5. **Branded types** for IDs that are all strings: session id, account id, project path, task id.
6. **Interfaces and DI** (`principles.md`): `claudestrator/src/core/` is the natural seam. Pass fs, process runner, git and clock in as small interfaces so the engine can be tested with fakes (this replaces `test/fixtures/fake-claude.js`-style stubs where possible).
7. **Build**: the output must still be what `package.json` `"main"` points to. Decide on `tsc` vs. a bundler (esbuild) per extension. Update `.vscodeignore` (currently empty) so `src/*.ts` and `node_modules` are not shipped, and so the `.vsix` contains only the build output and `media/`. Build before `vsce package`.
8. **Release pipeline**: add the build step to `.github/workflows/release.yml` and `ci.yml` (`npm run build` before `npm test`/`vsce package`). Tests: either keep `node --test` against compiled output, or run `.ts` directly (`node --experimental-strip-types`; note that Node 22.14 needs the flag and CI uses Node 24).
9. **Webview scripts** (`media/*.js`) run in the browser, not Node. They need their own `tsconfig` (DOM lib, no Node types).
10. **A migration commit is `refactor(<ext>):`** so it does not trigger a release. Behaviour changes found along the way go in separate `fix`/`feat` commits.
11. After migrating, update this file: remove the "plain JavaScript" statement and replace the JS section with the TS rules.
