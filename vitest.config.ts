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
    // Fork workers intermittently exit during a PARALLEL run on Windows —
    // still true, re-measured: turning this back on kills two workers within a
    // handful of runs. That is the reason this is off and it has not changed.
    //
    // It was NOT the reason serial runs died too. That was a different fault
    // with the same symptom: two files written for `node:test` sat inside these
    // globs, so vitest imported them, ran none of their tests, reported them
    // PASSED — and `node:test`'s own harness then started out of band and tore
    // the worker down partway through some later file. Both are converted, and
    // `test/test-runner-ownership.test.ts` fails the build if either runner
    // ever collects a file belonging to the other.
    //
    // READ A DEAD WORKER AS A FAILURE. A fork still dies every few runs, in a
    // different file each time, and it surfaces as a nonzero exit with a
    // near-green summary (`Test Files 244 passed (245)`) and no named file. The
    // count in brackets is the truth and the one before it is not; the run did
    // NOT pass. To find the file that was lost, re-run with
    // `--reporter=json --outputFile.json=./res.json` and look for the tests left
    // `pending` — they belong to the file that was cut short.
    //
    // Ruled out, so nobody repeats the search: it is not an unhandled rejection
    // (survives `--unhandled-rejections=warn`, and no warning is emitted), not a
    // V8 fatal error or an uncaught exception (`--report-on-fatalerror`
    // `--report-uncaught-exception` write no report), not a catchable signal
    // (`--report-signal=SIGTERM` writes none either — consistent with a Windows
    // `TerminateProcess`, which no handler sees), and not `teardownTimeout` or
    // `hookTimeout` (raising either alone still dies within three runs). The
    // `threads` pool did not reproduce it in three runs, which is the next thing
    // to try if this becomes worth another look.
    fileParallelism: false,
    environment: 'node',
    globals: false,
  },
});
