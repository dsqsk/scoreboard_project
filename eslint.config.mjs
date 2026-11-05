import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier/flat'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.preview/**',
      '**/.swc/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      'docs/**',
      'reports/**',
      'tasks/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/miniapp/src/**/*.{ts,tsx}', 'apps/miniapp/scripts/preview/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        wx: 'readonly',
        defineAppConfig: 'readonly',
        definePageConfig: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    files: ['**/*.wx.js'],
    languageOptions: { sourceType: 'script', globals: { wx: 'readonly' } },
  },
  prettier,
)
