import type {XoConfigItem} from 'xo';

const xoConfig: XoConfigItem[] = [
  {ignores: ['test/temp', 'coverage', '*.md']},
  {
    space: true,
    rules: {
      'capitalized-comments': 'off',
      '@typescript-eslint/naming-convention': 'off',
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
