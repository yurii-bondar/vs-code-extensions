# Claudestrator for JetBrains IDEs

The [Claudestrator](../../claudestrator) extension for VS Code, as a plugin for WebStorm, IntelliJ IDEA, PyCharm, GoLand and the other IntelliJ-based IDEs. The dashboard, the task list, the status bar items and the notifications behave the same, because they are the same code.

## How it works

Nothing of the engine or the dashboard is rewritten. The plugin is a thin Kotlin shell around the VS Code extension's own code:

```
 IDE (Kotlin)                                   Node process ("engine", started by the plugin)
┌──────────────────────────────┐   stdio, JSON  ┌──────────────────────────────────────────┐
│ tool window: task list       │ ◄────────────► │ sidecar/src/main.ts                       │
│ editor tab: JCEF browser ────┼── page ◄─► ────┤   Orchestrator + DashboardPanel           │
│   (claudestrator/media/*)    │                │   (claudestrator/src, unchanged)          │
│ status bar, notifications,   │                │ sidecar/src/vscode-shim.ts                │
│ settings, dialogs, terminals │ ◄── requests ──┤   stands in for the `vscode` module       │
└──────────────────────────────┘                └──────────────────────────────────────────┘
```

- **The page** (`claudestrator/media/*.ts`, built by the extension) is shown in the IDE's embedded browser. `acquireVsCodeApi()` and `--vscode-*` CSS variables are answered by the plugin (`PageHtml.kt`, `ThemeCss.kt`), so the page follows the IDE theme.
- **The engine** runs as a Node process. The build bundles it with esbuild, aliasing `vscode` to `sidecar/src/vscode-shim.ts`, which keeps settings and file watching itself and asks the IDE for everything an editor does (dialogs, opening files, terminals, secrets). The wire is one JSON object per line (`sidecar/src/protocol.ts` ↔ `engine/Protocol.kt`).
- **What `extension.ts` does** in VS Code (task list, status bar, notifications, commands) is Kotlin here: `ui/`, `Notifier.kt`, `actions/`.

When the extension's engine or page changes, nothing here changes unless the wire does: rebuild and the plugin has it.

| VS Code | JetBrains |
|---|---|
| Activity bar view "Tasks" | Tool window "Claudestrator" (left) |
| Dashboard webview panel | Editor tab (JCEF) |
| `claudestrator.*` settings | Settings | Tools | Claudestrator (+ the dashboard's own Settings) |
| Commands (`Claudestrator: …`) | Tools | Claudestrator, the tool window's title and gear menus, Find Action |
| Status bar items | Status bar widgets (tasks, Claude limits) |
| Secret storage (Atlassian token) | Password safe |
| Integrated terminal | Sign-ins run in the Run tool window; "continue in terminal" opens the Terminal tool window with the command on the clipboard |
| Editor context menu "Start a Task from Selection" | Editor context menu, same name |

## Requirements

- An IDE based on IntelliJ Platform **2026.2 or newer** (`since-build` 262) with JCEF. From 2026.2 the embedded browser is a plugin of its own (`com.intellij.modules.jcef`), bundled with every standard IDE; older IDEs keep it in the core under no plugin id, so one build cannot serve both.
- **Node.js 20+** on the `PATH` of your login shell, or its path in the settings. It is not bundled, which keeps the plugin at ~450 KB. 20 because the engine watches its task and config folders recursively, which Node supports on Linux only from 20.
- The same tools as the extension: Claude Code CLI, Git, GitHub CLI.

## Build and run

```bash
(cd ../../claudestrator && npm ci)   # once: the engine's and the page's dependencies
(cd sidecar && npm ci)               # once: esbuild
./gradlew runIde                     # an IDE with the plugin in a sandbox
./gradlew buildPlugin                # build/distributions/claudestrator-<version>.zip
./gradlew verifyPlugin               # Plugin Verifier against the IDEs in build.gradle.kts
```

`buildPlugin` runs `npm run build` in `claudestrator/` and `sidecar/` itself. The zip holds `lib/` (the Kotlin jar) and `engine/` (the bundled engine and the page's files, which Node needs as real files).

The JDK that runs Gradle is any 17+; the build downloads JDK 21 for compiling.

## Publishing to JetBrains Marketplace

Marketplace rules this project is set up for: a unique plugin id, English description (≥ 40 chars), vendor, license, `since-build` with no upper bound, no bundled Kotlin stdlib, only platform modules as dependencies (so it loads in every IDE), a notification group for everything it shows, no work on the UI thread, a clean Plugin Verifier run.

1. **Account and first upload.** Create the plugin at <https://plugins.jetbrains.com/plugin/add> and upload `build/distributions/claudestrator-<version>.zip` by hand. The first version is moderated (usually a few working days). Review the vendor entry (`plugin.xml` has a name and URL, no email: add one in the Marketplace profile if you want users to reach you).
2. **Token.** Marketplace → profile → *My Tokens*. Export it as `PUBLISH_TOKEN`.
3. **Signing** (required for `publishPlugin`):
   ```bash
   openssl genpkey -aes-256-cbc -algorithm RSA -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
   openssl rsa -in private_encrypted.pem -out private.pem
   openssl req -key private.pem -new -x509 -days 365 -out chain.crt
   ```
   Then `CERTIFICATE_CHAIN` (contents of `chain.crt`), `PRIVATE_KEY` (contents of `private.pem`) and `PRIVATE_KEY_PASSWORD`. Keep the key out of git (`.gitignore` already skips it) and back it up: a plugin must keep being signed with the same chain.
4. **Release.** Raise `pluginVersion` in `gradle.properties`, then `./gradlew signPlugin publishPlugin`. `PUBLISH_CHANNEL=eap` publishes to the early-access channel first.

Marketplace asks for a stable plugin id: `bondevn.claudestrator` (in `plugin.xml`) is permanent once published.

## Not done yet

- **Releases are manual.** The VS Code extensions release with semantic-release per folder; this plugin has no pipeline yet (CI build + `verifyPlugin`, then `publishPlugin` on a tag).
- **No automated tests** for the Kotlin side. The sidecar was exercised by hand over stdio (`init` → `dashboard` → page `boot` → `shutdown`); the engine's own tests stay in `claudestrator/`.
- **Texts that name VS Code.** A few lines of the page mention VS Code (for example "kept in VS Code's secret storage"). They are the extension's strings; making them host-aware is a change in `claudestrator/media`.
- **Windows and Linux** are untested; the "continue in terminal" command put on the clipboard is quoted for POSIX shells and PowerShell.
- **JetBrains Gateway / remote development:** JCEF is limited there; the dashboard may not open.
- **Command palette pickers** (`Answer…`, `Stop Task` without a selected task) exist as tree context menu items only.
