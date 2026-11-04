# design-sync

Rebuilds the Penpot design file's **Screens** page from the dashboard as the code draws it, so the design never drifts
from the code. Every screen is rendered by the real dashboard (the preview harness), in the Claudestrator palette, and
rebuilt in Penpot as editable layers: frames, texts and icons, placed as the page lays them out (no auto-layout, no
component instances).

| File | Runs in | Does |
|---|---|---|
| `capture.mjs` | Node | opens each screen in headless Chrome, applies a theme, writes `out/<screen>--<theme>.json` (+ `.png` to compare) and `out/screens.json` |
| `walker.js` | the page | the rendered DOM as a tree of boxes, texts and icons, in page coordinates |
| `themes.mjs` | the page | the palette of Penpot's `Theme/*` tokens as the `--vscode-*` variables the dashboard reads |
| `serve.mjs` | Node | serves `out/` and `builder.js` to Penpot's plugin |
| `builder.js` | Penpot's plugin | builds the boards of `out/screens.json` on the page **Screens** |
| `cdp.mjs` | Node | a small Chrome DevTools Protocol driver |

## Run

1. The preview, configured, with the fake agent quick (from `claudestrator/`):

   ```sh
   npm run build && PREVIEW_SETUP=1 PREVIEW_DELAY=50 node dist/test/harness/server.js
   ```

2. Capture (Chrome is found on macOS, Linux and Windows; else set `CHROME`). The first run starts the sample task the
   task screens show and waits for its plan:

   ```sh
   node scripts/design-sync/capture.mjs                # every screen
   node scripts/design-sync/capture.mjs task Dark      # some screens, some themes
   ```

3. Serve the capture: `node scripts/design-sync/serve.mjs`.

4. In Penpot, open the design file, connect the MCP plugin (File → MCP server → Connect) and keep its tab in front.
   Through the Penpot MCP server's `execute_code`, run until `left` is 0:

   ```js
   const code = await (await fetch('http://127.0.0.1:4799/builder.js')).text();
   return await new Function('storage', 'penpot', 'penpotUtils', `return (${code})`)(storage, penpot, penpotUtils).run(40000);
   ```

   Each call builds what it can in 40 seconds (a plugin call is cut at two minutes, and Penpot's backend slows while it
   saves). A board replaces the one of the same name; boards already built from this capture are skipped, so a call cut
   short is simply run again.

## What to keep in step

- `SCREENS` in `capture.mjs`: the boards, their names and places. A new page of the dashboard gets a row there.
- `themes.mjs`: the palette, copied from Penpot's `Theme/*` token sets. Change it with them.
- The sample tasks (`FIX` in `capture.mjs`) stand in for a workspace with stories, an epic, a group and finished tasks.
