import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      // The codebase predates ESLint and uses `any` extensively at provider/
      // route boundaries; enforcing the ban today would be a giant unrelated
      // refactor. Keep the rule off until that cleanup lands.
      '@typescript-eslint/no-explicit-any': 'off',
      // Standard test-scaffolding conventions: `_`-prefixed names are
      // intentionally unused, and empty catch blocks assert error paths.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // A switch over a union (a state machine's phase or event) must handle every
  // member, or keep a deliberate `default`. This rule needs type information,
  // so it runs on source only: tests sit outside tsconfig.json.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  },
])
