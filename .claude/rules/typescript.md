---
paths:
  - "**/*.ts"
  - "**/*.mjs"
---

# TypeScript

Always-on for every `.ts` in the extension folders, not just in hot-path code. Every extension is TypeScript. Performance-specific rules live in the `ts-performance` skill.

## Safety

- **Strict tsconfig** — `strict: true` minimum. Add `noUncheckedIndexedAccess` (index access may return `undefined`) and `exactOptionalPropertyTypes` (optional field ≠ explicit `undefined`). Share one `tsconfig.base.json` at the repo root; each extension extends it.
- **No `any`.** `any` silently disables type checking across the entire call chain. Type external data as `unknown` and narrow immediately via type guards or explicit parsing. Situations that truly require `unknown` are rare; if you reach for it, verify the data cannot be typed at the boundary instead.
- **Boundaries of this repo** — everything below arrives untyped and is narrowed once, at the edge:
  - JSON/YAML from disk: `~/.claude*/` (`.claude.json`, session `.jsonl`), `settings.json`, `.claudestrator/` config
  - Claude Code hook payloads and statusline stdin
  - `webview.postMessage` / `onDidReceiveMessage` messages
  - `vscode.workspace.getConfiguration().get()` results
- **One intended type.** Every parameter, return value, DTO field and exported constant has an explicit, single intended type. Do not use loose unions such as `string | boolean` when the contract can be one type — normalize at the boundary (parse, validate, map) so downstream code sees one type.
- **Exhaustive checks via `never`** — for discriminated unions, `switch` with a `default` branch assigning to a `never` variable. The compiler catches forgotten cases when new union variants are added. Webview message types and task/pipeline states are the main candidates.
- Prefer `interface` for object contracts that may be extended; `type` for unions, mapped types and function signatures.
- Prefer small helpers, early returns, `async/await`, config objects over boolean flag parameters, and `Readonly` where practical.

## Generics

- **No generic without real variance** — if always called with the same concrete type, it's premature abstraction (YAGNI).
- **Constrain generics** (`T extends X`) — bare `<T>` loses the type safety the generic was written for.
- **Branded types for domain IDs** — `type SessionId = string & { __brand: 'SessionId' }` prevents substituting `TaskId` or `AccountId` where `SessionId` is expected, even though all are technically `string`. Same for absolute vs. relative paths.
- **Trust inference** — explicit `<T>` at call site is a signal the function signature is poorly designed.
- **3+ type parameters → split** — same as "function doesn't fit one screen", but for types.

## Extension specifics

- `@types/vscode` is pinned to the same range as `engines.vscode`; do not use an API newer than that engine.
- Webview scripts (`media/*.ts`) run in the browser: DOM lib, no Node types, separate `tsconfig`.
- Build output must match `package.json` `"main"`; source `.ts` and `node_modules` stay out of the `.vsix` (`.vscodeignore`).
