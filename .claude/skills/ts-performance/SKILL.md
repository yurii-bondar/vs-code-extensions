---
name: ts-performance
description: Use when writing or reviewing performance-sensitive TypeScript/Node.js code in the VS Code extensions — extension activation, scanning large files (Claude session `.jsonl` transcripts), file-watcher and tree refresh paths, polling timers, child-process calls, webview messaging. For always-on type-safety rules (any/unknown, strict tsconfig, never-exhaustiveness), see `.claude/rules/typescript.md` — not repeated here.
---

# TypeScript Performance — VS Code Extension Hot-Paths

An extension runs inside the **extension host**, a Node process shared with every other extension in the window. A slow or blocking extension freezes the whole window, not one request. The bottlenecks here are:

- **Activation** — most extensions activate on `onStartupFinished`; everything in `activate()` delays other extensions
- **Large file scans** — session `.jsonl` transcripts (`claude-ctx-man/src/sessions.js`), task stores and transcripts (`claudestrator/src/core/store.js`) can reach tens of MB
- **Refresh paths** — `FileSystemWatcher` events and `setInterval` ticks that rebuild tree views (`claudestrator/extension.js`, `claude-ctx-man/extension.js`)
- **Child processes** — `git`, shell and `claude` calls from `src/core/git.js`, `statusline`
- **Webview messaging** — `postMessage` between the extension and `media/*` scripts

Apply the patterns below only in these contexts. For ordinary command handlers and config code, readability trumps micro-optimisation. Measure before optimising.

---

## Keep Activation Cheap

`activate()` registers commands, views and watchers, then returns. No file scans, no process spawns, no network.

- Defer first data load until a view is expanded or a command runs (`onDidChangeVisibility`, `setTimeout(0)`).
- `require()` heavy modules (`yaml`, large core modules) lazily inside the handler that needs them.
- Prefer a narrower activation event (`onView:`, `onCommand:`, `workspaceContains:`) over `onStartupFinished` when the feature allows.

---

## Never Block the Extension Host

No `*Sync` I/O or `spawnSync` / `execFileSync` on the paths triggered by UI events, watchers, timers or tree `getChildren`.

```typescript
// bad — blocks every extension in the window while git runs
const branch = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });

// good — async, with a timeout
const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
```

`*Sync` is fine in one-shot startup of a short-lived script (the statusline renderer, the PreToolUse hook), where blocking is the point and there is no host to starve. Do not copy that pattern into code that runs inside `extension.js`.

---

## Streaming for Large Files

Do not read a whole transcript into memory just to look at part of it.

```typescript
// bad — whole file as a string, then a full split
const entries = parseLines(fs.readFileSync(file, 'utf8'));

// good — line by line, stop early when possible
const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  const entry = parseLine(line);
  if (entry && found(entry)) break;
}
```

When only the head or tail is needed (title, last message, token counters), read just that slice with `fs.read` at an offset instead of the full file.

---

## Debounce Watchers and Timers

- A `FileSystemWatcher` fires many events per save (create + change). Coalesce them with a trailing debounce (100–300 ms) before refreshing a tree.
- Refresh only the changed node (`onDidChangeTreeData.fire(node)`), not the whole tree, when the change is local.
- Do not poll when an event exists. If polling is unavoidable, stop the timer when the view is hidden and dispose it with the extension (`context.subscriptions`).
- Skip the refresh when the data is unchanged (compare a cheap signature: `mtimeMs` + `size`).

---

## Cache by File Signature

Parsed JSON/YAML/`jsonl` that is read repeatedly (accounts from `.claude.json`, config, session lists) is cached by `path → { mtimeMs, size, value }` and re-parsed only when the signature changes. Use a `Map`, not a plain object (below).

---

## Map/Set over Dynamic Objects for Lookup Tables

If keys are frequently added and removed — use `Map`/`Set`, not `{ [key: string]: T }`. A plain object as a dictionary breaks hidden classes and is slower on key deletion, and keys like `__proto__` become a correctness hazard when the keys are session ids or file paths.

```typescript
// bad — for a table built and queried on every refresh
const index: Record<string, Session> = {};

// good
const index = new Map<SessionId, Session>();
```

---

## Stable Object Shapes (Hidden Classes)

Applies to objects created per line or per record in scans (thousands per file). Do not change an object's shape after creation — no `delete obj.prop`, no adding fields later. Initialise all fields at creation, even as `null`.

```typescript
// bad — shape changes after creation
const row: Partial<SessionRow> = {};
row.id = entry.sessionId;
row.title = entry.title;

// good — full shape upfront
const row: SessionRow = { id: entry.sessionId, title: entry.title, updatedAt: null };
```

---

## Loops in Bulk Processing

In performance-critical sections (iterating 10k+ transcript lines) — classic `for` / `for...of`, not chained `.map().filter().reduce()`. Chained methods create intermediate arrays. Outside bulk loops, readability wins — use the functional style.

---

## Minimise Allocations in Tight Loops

Avoid `structuredClone` / `JSON.parse(JSON.stringify())` for deep copies on hot paths. Parse each line once, pick the fields you need, and drop the rest. Do not `JSON.parse` a line that a cheap substring check (`line.includes('"type":"assistant"')`) can reject first.

---

## Webview Messaging

- Send deltas or ids, not the full state, on every change. `postMessage` serialises the whole payload.
- Batch bursts of updates into one message per animation frame / debounce window.
- Keep large strings (transcripts, diffs) out of messages; send a reference and let the webview request a slice.
- Narrow message types are a discriminated union (see `typescript.md`), so a new message cannot be forgotten in the handler.

---

## Not Relevant Here

These patterns from backend work do not pay off at this scale; do not add them:

- Typed arrays for numeric aggregation, pre-allocated arrays — no numeric bulk data
- Compiled validation schemas (TypeBox/ArkType) — no per-row validation of 50k-row imports; a hand-written guard at the boundary is enough
- Streaming CSV/XLSX libraries — the extensions export nothing at that size
