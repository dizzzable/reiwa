import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import globals from 'globals'

/**
 * Flat ESLint config for the reiwa cabinet SPA.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Until it did, THE CABINET HAD NO LINTER AT ALL — no config, no script, no CI
 * step — while the panel SPA had all three. So `rules-of-hooks` never ran here
 * once, in the app customers actually open. A hook called behind an `if` is not
 * a style question: React reads hooks by call order, so one conditional hook
 * takes down the whole page, and that is exactly how the cabinet went white
 * once. TypeScript cannot see it, the build cannot see it, and a test only sees
 * it if someone happened to render that branch.
 *
 * ── The ruleset ──────────────────────────────────────────────────────────────
 *
 * Deliberately the panel's, minus its a11y block: two SPAs in one product
 * should not disagree about what a bug is, and a reviewer moving between them
 * should not have to remember which repo they are in. The React-Compiler rules
 * that ship with `eslint-plugin-react-hooks` 7 stay at `warn` for the same
 * reason they do there — they surface real bugs, but nobody has audited this
 * tree for them yet, and a first run that blocks CI on hundreds of findings
 * gets switched off rather than fixed. `rules-of-hooks` and `exhaustive-deps`
 * are errors, because those are the two that cost us a page.
 *
 * Accessibility is NOT here yet, and that is a gap worth naming: this is the
 * customer-facing app, so it needs `jsx-a11y` more than the panel does. It is
 * left out of the first landing on purpose — as warnings nobody would action
 * it would only teach people to ignore the output. It belongs in its own pass,
 * with someone reading the findings.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dev-dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      '**/*.tsbuildinfo',
      // Build-time helpers run by node, not shipped: they have their own
      // globals and no hooks to get wrong.
      'scripts/**',
      // ── The vendored effects kit ──────────────────────────────────────────
      //
      // `src/components/reactbits/*` is third-party shader code, adapted but
      // not authored here, and the panel ignores its own copy for the same
      // reason: reformatting it to our taste only makes the next re-sync
      // harder, and 28 of the 33 errors on the first run were `prefer-const`
      // inside it. The files we DO own live next to it — the layer that drives
      // those renderers is ours, full of hooks, and is exactly what a linter is
      // for here — so they stay in.
      //
      // Matched by CASE, the only thing separating the two on disk: every
      // vendored renderer is a PascalCase file, everything we wrote is
      // kebab-case. A blanket `reactbits/**` would not do — ESLint prunes an
      // ignored directory, and a later `!` cannot reach back inside it.
      'src/components/reactbits/[A-Z]*.{ts,tsx}',
      'src/components/reactbits/originkit/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/static-components': 'warn',
      'react-hooks/use-memo': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/set-state-in-render': 'warn',
      'react-hooks/config': 'warn',
      'react-hooks/gating': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // ESLint 10 made this an error in `js.configs.recommended`; it still
      // reports real patterns as false positives (`let a = []; [a, b] = await
      // Promise.all(...)`). Same call as the panel — revisit when upstream is
      // more conservative.
      'no-useless-assignment': 'off',
      // `let x; …reads x…; x = make()` is how a WebGL setup closes a resize
      // handler over a program it has not built yet. The variable really is
      // assigned once, so the rule is right about the fact and wrong about the
      // rewrite: `const` cannot be declared anywhere that handler could still
      // see it. This option exists for exactly that shape.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // The service worker and the policy it shares with the app run off
    // `ServiceWorkerGlobalScope`, not `window`.
    files: ['src/sw.ts', 'src/sw-cache-policy.ts'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
