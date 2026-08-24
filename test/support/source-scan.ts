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
 * Deliberately conservative: block comments go, and so do lines that are
 * ENTIRELY a line comment — but a `//` appearing mid-line is left alone. The
 * naive version cuts every line at its first `//`, which turns
 * `new Redis("redis://host", …)` into `new Redis("redis:` and makes the one
 * offender shaped most like real code invisible. A guard that misses the thing
 * it guards is worse than no guard, and this exact false negative was found by
 * running it.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}
