import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'release.config.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `catch {}` and `_`-prefixed names are deliberate; everything else unused is a mistake.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  }
);
