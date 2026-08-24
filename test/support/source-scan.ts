import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Helpers for guards that assert something about EVERY construction site in
 * `src/` rather than about the three or four that exist today.
 *
 * The failure mode these serve is always the same shape: a client, a pool, a
 * dispatcher built next year by someone who never read the incident that made
 * the options mandatory. A guard that names the known sites guards the past.
 */

/** Every `.ts` file under `dir`, recursively. */
export function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * Removes comments so prose ABOUT a call is not read as the call.
 *
 * ── Order matters, and getting it wrong blinds every guard built on this ────
 *
 * Line comments are removed FIRST. The obvious implementation strips block
 * comments first, and on 2026-08-24 that silently ate half of `web/src/sw.ts`:
 * the file documents its routes in a line comment reading
 * `//   /support, /linking/*, /push/*, /realtime/*.`, and each of those globs
 * opens a block comment as far as a regex is concerned. The file held SEVEN
 * `/*` against ONE `*​/`, so the strip ran from the first glob to the only real
 * terminator and took the `WebPushPayload` interface with it.
 *
 * What makes that worse than a wrong answer is the DIRECTION of the wrong
 * answer: a guard that scans code it has accidentally deleted reports no
 * offenders and passes. It was caught only because a spec asserted something
 * had to be PRESENT — the presence check is what turned a silent blindness
 * into a red test, which is why one is kept in each guard.
 *
 * ── What is still not handled ───────────────────────────────────────────────
 *
 * A `/*` inside a string literal on a line of real code will still hijack the
 * block strip. Nothing in these repositories does that today, and handling it
 * properly means tokenising rather than matching. Recorded rather than
 * pretended away: if a guard here ever reports zero offenders in a file you
 * know contains one, look here first.
 */
export function stripComments(source: string): string {
  // ONLY `//` lines here — never ` *` continuation lines. Filtering those too
  // removes the ` *​/` that TERMINATES every JSDoc block, which leaves each
  // `/**` opener unpaired and sends the block strip below hunting for the next
  // terminator anywhere in the file. That deleted whole classes out of
  // `transport.ts` on the first attempt at this fix. Continuation lines need no
  // special handling: they are inside a block comment, and the block strip
  // takes them with it.
  const withoutLineComments = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  return withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
}
