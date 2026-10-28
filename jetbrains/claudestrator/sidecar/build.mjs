// Bundles the Claudestrator engine and the stdio bridge into dist/engine/, laid out like the VS Code extension
// (dist/hook/pretooluse.js, media/, dist/media/*.js), because the engine looks for its files by that layout.
// `vscode` is replaced by src/vscode-shim.ts, which hands what the engine asks of an editor to the IDE.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, '../../../claudestrator');
const out = resolve(here, 'dist/engine');

// The webview scripts are built by the extension itself (`npm run build` there).
const webviewJs = join(ext, 'dist/media');
if (!existsSync(join(webviewJs, 'app.js'))) {
  console.error(`Missing ${webviewJs}/app.js. Run \`npm ci && npm run build\` in claudestrator/ first.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist/hook'), { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: false, legalComments: 'none', logLevel: 'info' };

await build({
  ...common,
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(out, 'dist/sidecar.js'),
  alias: { vscode: join(here, 'src/vscode-shim.ts') },
  // `yaml` is the engine's only dependency; it lives in the extension's node_modules.
  nodePaths: [join(ext, 'node_modules')],
});

// Claude Code runs the guard hook as a script of its own, so it is a separate, self-contained file.
await build({ ...common, entryPoints: [join(ext, 'hook/pretooluse.ts')], outfile: join(out, 'dist/hook/pretooluse.js') });

cpSync(join(ext, 'media'), join(out, 'media'), { recursive: true, filter: (src) => !src.endsWith('.ts') });
mkdirSync(join(out, 'dist/media'), { recursive: true });
for (const f of readdirSync(webviewJs)) if (f.endsWith('.js')) cpSync(join(webviewJs, f), join(out, 'dist/media', f));
