import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every collected test file must belong to the runner that collects it.
 *
 * ── What this exists to prevent ───────────────────────────────────────────
 *
 * This repository runs two test runners: vitest for everything, and `node:test`
 * for the property-based suite (`*.property.test.ts`, run by `npm run test:pbt`
 * and excluded from vitest's globs). A file written for `node:test` that does
 * NOT carry that suffix falls between them, and the way it fails is silent in
 * both directions:
 *
 *  1. vitest imports it, finds no vitest tests in it, and reports the file as
 *     PASSED with "no tests" — so 42 real assertions read as green while never
 *     executing. Both files this test was written for had drifted so far that
 *     23 of those 42 failed the moment they were finally run: their admin-client
 *     fakes were still flat after the client was split into namespaces, one
 *     endpoint had changed from DELETE to POST, and the rate limiter had moved
 *     to a Lua script the fake Redis did not implement.
 *  2. Worse, `node:test`'s harness starts anyway, out of band, and tears the
 *     worker down partway through some LATER file — reported only as
 *     "Worker exited unexpectedly", with a near-green summary
 *     (`Test Files 244 passed (245)`) and no clue which file was lost. That
 *     flake was chased for two releases before it was traced back here.
 *
 * Scanning the source text rather than importing keeps this cheap and keeps it
 * honest: a file cannot hide its runner from a grep the way it can hide a
 * failure from a summary.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..');

/** Mirrors `vitest.config.ts`: what vitest collects, and what it excludes. */
const COLLECTED_ROOTS = ['test', 'src', join('web', 'test')];
const PROPERTY_SUFFIX = '.property.test.ts';

async function collectedTestFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(full);
        continue;
      }
      if (!/\.test\.tsx?$/.test(entry.name)) continue;
      if (entry.name.endsWith(PROPERTY_SUFFIX)) continue;
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  };
  for (const root of COLLECTED_ROOTS) await walk(join(ROOT, root));
  return out.sort();
}

describe('test-runner ownership', () => {
  it('finds the files it is supposed to be scanning', async () => {
    // A walker that silently found nothing would make every assertion below
    // vacuously true — the exact shape of failure this file is about.
    const files = await collectedTestFiles();
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no vitest-collected file that imports node:test', async () => {
    const offenders: string[] = [];
    for (const file of await collectedTestFiles()) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      if (/from\s+['"]node:test['"]/.test(source)) offenders.push(file);
    }
    expect(
      offenders,
      'these files are collected by vitest but written for node:test — vitest will report ' +
        'them as passing with no tests, and the node:test harness will kill the worker ' +
        'partway through some later file. Either convert them to vitest, or rename them ' +
        'to *.property.test.ts so `npm run test:pbt` owns them.',
    ).toEqual([]);
  });

  it('keeps the property suite on node:test, where its runner is', async () => {
    // The other direction: a property file that quietly switched to vitest
    // imports would be excluded from vitest's globs AND fail under node:test.
    const walk = async (dir: string): Promise<string[]> => {
      const found: string[] = [];
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return found;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          found.push(...(await walk(full)));
        } else if (entry.name.endsWith(PROPERTY_SUFFIX)) {
          found.push(full);
        }
      }
      return found;
    };
    const property = await walk(join(ROOT, 'test'));
    expect(property.length).toBeGreaterThan(0);
    const wrong = property
      .filter((file) => /from\s+['"]vitest['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).split(sep).join('/'));
    expect(
      wrong,
      'a *.property.test.ts file imports vitest, but vitest excludes that suffix and ' +
        '`npm run test:pbt` runs it under node:test — it would run nowhere',
    ).toEqual([]);
  });
});
