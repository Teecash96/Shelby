import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'evidence/**', '.proofvault/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
