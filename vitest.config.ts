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

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.property.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    globals: false,
  },
});
