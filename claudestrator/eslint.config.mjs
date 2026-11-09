import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'media/**/*.js', 'release.config.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // design-sync and the browser tests: Node scripts, and two that run elsewhere: walker.js in the page, builder.js in Penpot's plugin.
    files: ['scripts/**/*.{js,mjs}', 'test/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', fetch: 'readonly', WebSocket: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', URL: 'readonly',
        document: 'readonly', window: 'readonly', getComputedStyle: 'readonly', innerHeight: 'readonly', scrollX: 'readonly', scrollY: 'readonly',
        NodeFilter: 'readonly', SVGElement: 'readonly', DOMMatrix: 'readonly',
        penpot: 'readonly', penpotUtils: 'readonly', storage: 'readonly',
      },
    },
  },
  {
    rules: {
      // `catch {}` and `_`-prefixed names are deliberate; everything else unused is a mistake.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  }
);
