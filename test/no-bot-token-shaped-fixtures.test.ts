/**
 * NO FAKE BOT TOKEN IN THE SHAPE OF A REAL ONE.
 *
 * GitHub's secret scanning matches a Telegram bot token as digits, a colon and
 * exactly 35 characters after it, and reports the match as a public leak — a
 * fake token in a spec included (alert #1, test/bot/middleware/config-freshness).
 * A fixture token stays usable at any other length, so keep it off 35.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);
const TOKEN_SHAPE = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|tsx|js|mjs|json|md|ya?ml)$/.test(name)) yield path;
  }
}

describe('fixture bot tokens', () => {
  it('none in src, test or web/src has the shape GitHub reports as a leaked bot token', () => {
    const hits: string[] = [];
    for (const top of ['src', 'test', 'web/src']) {
      for (const path of files(join(ROOT, top))) {
        if (TOKEN_SHAPE.test(readFileSync(path, 'utf8'))) hits.push(relative(ROOT, path));
      }
    }
    expect(hits).toEqual([]);
  });
});
