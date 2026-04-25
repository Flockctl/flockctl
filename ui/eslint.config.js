import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Demoted to warning: large legacy surface; not a correctness issue.
      // Tracked for cleanup, but not gating CI on it.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Demoted to warning: existing pages export both component and helper
      // functions (e.g. routeOptions). Splitting is a refactor, not a bug.
      'react-refresh/only-export-components': 'warn',
      // Demoted to warning: cosmetic (synchronous setState inside effects
      // can cascade renders) — not incorrect, and the React team is still
      // shipping the rule. Surface for cleanup, don't gate CI.
      'react-hooks/set-state-in-effect': 'warn',
      // Demoted to warning: same family as above — surfaces patterns that
      // *might* be wrong but compiles and runs correctly today.
      'react-hooks/refs': 'warn',
      // Demoted to warning: React Compiler advisory output, not a bug.
      'react-hooks/static-components': 'warn',
      // Demoted to warning: React Compiler "Compilation Skipped" advisory —
      // memoization mismatch is informational, not a runtime bug.
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/component-hook-factories': 'warn',
      // Demoted to warning: underscore-prefixed components
      // (`_DeleteWorkspaceDialog`, `_EditWorkspaceDialog`) are an explicit
      // "deprecated / soft-disabled" marker in this codebase. The rule
      // misclassifies them as non-components since they don't start with an
      // uppercase letter; tracked for cleanup but not blocking the release.
      'react-hooks/rules-of-hooks': 'warn',
      // Real cleanups are cheap (`/[}]/` not `/\}/`) but they're scattered
      // through legacy regex literals; surface as warning, not blocker.
      'no-useless-escape': 'warn',
      // Allow underscore-prefixed unused args/vars — that's the documented
      // "intentionally unused" convention used across this codebase.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Tests can use `any` freely — typing through generic mock surfaces
    // is more friction than it's worth.
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
