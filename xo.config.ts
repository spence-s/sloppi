import type {XoConfigItem} from 'xo';

const xoConfig: XoConfigItem[] = [
  {ignores: ['test/temp', 'coverage', '*.md']},
  {
    space: true,
    rules: {
      'capitalized-comments': 'off',
      '@typescript-eslint/naming-convention': 'off',
      // TypeBox exposes schema builders as capitalized functions rather than constructors.
      'new-cap': ['error', {capIsNewExceptionPattern: String.raw`^Type\.`}],
      '@stylistic/max-len': 'off',
      'max-depth': 'off',
      complexity: 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      // ensure we don't get empty module imports while using verbatim module syntax
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // Enforce using .ts extensions for local imports in TS files
      // for native node.js type stripping support
      'import-x/extensions': [
        'error',
        'always',
        {
          ts: 'always',
          cts: 'always',
          mts: 'always',
          tsx: 'always',
          // Never allow relative js extensions in TS files
          js: 'never',
          jsx: 'never',
          cjs: 'never',
          mjs: 'never',
        },
      ],
    },
  },
  {
    files: ['package.json'],
    rules: {
      // Pi packages use their `pi` manifest as the entry point, and Playwright is intentionally pinned.
      'package-json/require-entry-point': 'off',
      'package-json/dependency-version-range': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
    },
  },
  {
    files: ['agent/prompts/*.md'],
    rules: {
      'markdown/no-missing-label-refs': 'off',
    },
  },
];

export default xoConfig;
