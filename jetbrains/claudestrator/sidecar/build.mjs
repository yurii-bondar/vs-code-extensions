// Bundles the Claudestrator engine and the stdio bridge into dist/engine/, laid out like the VS Code extension
// (media/, dist/media/*.js), because the engine looks for its files by that layout.
// `vscode` is replaced by src/vscode-shim.ts, which hands what the engine asks of an editor to the IDE.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
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
mkdirSync(join(out, 'dist'), { recursive: true });

const SANDBOX = '@anthropic-ai/sandbox-runtime';
const common = { bundle: true, platform: 'node', target: 'node18', format: 'cjs', sourcemap: false, legalComments: 'none', logLevel: 'info' };

await build({
  ...common,
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(out, 'dist/sidecar.js'),
  alias: { vscode: join(here, 'src/vscode-shim.ts') },
  // `yaml` is bundled from the extension's node_modules. The sandbox runtime is not: the engine starts its CLI as a
  // process of its own (checks and git hooks run in it), so it ships as files, below.
  nodePaths: [join(ext, 'node_modules')],
  external: [SANDBOX],
});

// The sandbox runtime and what it needs, as installed in the extension: no Windows helper (no sandbox there), and none
// of the sources, browser builds, types and docs that come with the packages.
const SKIP = /[\\/](vendor[\\/]srt-win|zod[\\/]src|node-forge[\\/](dist|flash))($|[\\/])|\.map$|\.d\.c?ts$|README\.md$/;
const shipped = new Set();
const ship = (name) => {
  if (shipped.has(name)) return;
  shipped.add(name);
  const from = join(ext, 'node_modules', name);
  cpSync(from, join(out, 'node_modules', name), { recursive: true, filter: (src) => !SKIP.test(src) });
  for (const dep of Object.keys(JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).dependencies || {})) ship(dep);
};
ship(SANDBOX);

// The page's files, as the .vsix ships them: not its TypeScript sources, nor the Marketplace screenshots.
const shots = join(ext, 'media', 'screenshots');
cpSync(join(ext, 'media'), join(out, 'media'), { recursive: true, filter: (src) => !src.endsWith('.ts') && src !== shots && !src.startsWith(shots + sep) });
mkdirSync(join(out, 'dist/media'), { recursive: true });
for (const f of readdirSync(webviewJs)) if (f.endsWith('.js')) cpSync(join(webviewJs, f), join(out, 'dist/media', f));
