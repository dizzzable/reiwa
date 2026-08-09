/**
 * Vitest config for reiwa.
 *
 * Wave 1B lands the harness; Wave 8 will populate `test/` with use-case
 * specs (translator, locale-detector, banner-store) and turn `test:watch`
 * into the inner-loop default. Until then `vitest run` is a no-op
 * (passes with zero matched files), keeping `npm test` green.
 *
 * Property-based tests (`*.property.test.ts`) stay on `node:test` —
 * they integrate fast-check via the node test runner and ship under the
 * separate `test:pbt` script. Excluding them here keeps the two
 * harnesses orthogonal.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    // `web/test` takes BOTH extensions. It used to take only `.tsx`, which
    // silently dropped every component contract written without JSX — and
    // `passWithNoTests` below meant even `vitest run <that file>` reported
    // success while collecting nothing. This is the only project CI runs tests
    // in (`web`'s CI job is typecheck and build only), so a file it does not
    // collect is a file that never runs anywhere.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'web/test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.property.test.ts'],
    passWithNoTests: true,
    // The mixed Node + jsdom suite is stable in isolation but fork workers
    // intermittently exit during a parallel run on Windows. Keep CI and local
    // `npm test` deterministic instead of accepting a false-red test command.
    fileParallelism: false,
    environment: 'node',
    globals: false,
  },
});
