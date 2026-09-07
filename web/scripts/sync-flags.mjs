/**
 * Copies the `flag-icons` SVG set into `public/flags/`.
 *
 * WHY THE FLAGS ARE NOT EMOJI. Windows ships no glyphs for regional-indicator
 * pairs at all, so `🇨🇿` renders as the two letters "CZ" — on every desktop
 * browser, in every font. The phone has them and the desktop does not, which is
 * exactly the report this exists to answer. `components/ui/flag-icon.tsx` had
 * already met the same wall and hand-drew two flags for the language switcher;
 * hand-drawing two hundred is not a thing anybody should do.
 *
 * WHY `public/` AND NOT AN IMPORT. Vite would turn 271 imported SVGs into 271
 * build chunks, and the service worker precaches `**\/*.svg` — every customer
 * would download two megabytes of flags on first load to see the six their
 * operator actually uses. As plain files under `public/` they are fetched one
 * at a time, by the browser, only when a server from that country is on screen.
 * `vite.config.ts` excludes them from the precache manifest for the same
 * reason.
 *
 * WHY THEY ARE NOT COMMITTED. 271 generated binaries in a diff help nobody, and
 * the source of truth is a pinned dependency. `predev` and `prebuild` run this,
 * so a fresh clone has them before anything can look for them.
 *
 * `flag-icons` is MIT, like both repositories.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', 'node_modules', 'flag-icons', 'flags', '4x3');
const fallback = resolve(here, '..', '..', 'node_modules', 'flag-icons', 'flags', '4x3');
const target = resolve(here, '..', 'public', 'flags');

const from = existsSync(source) ? source : fallback;
if (!existsSync(from)) {
  // Loud, not silent. A missing set means every flag on the servers screen
  // falls back to its country code, which looks like the defect this replaced
  // — and it would do so only in the image, where nobody is watching.
  console.error(
    'sync-flags: `flag-icons` is not installed. Run `npm install` in web/ first.\n' +
      `  looked in: ${source}\n  and:        ${fallback}`,
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
let bytes = 0;
for (const name of readdirSync(from)) {
  if (!name.endsWith('.svg')) continue;
  const file = join(from, name);
  copyFileSync(file, join(target, name));
  copied += 1;
  bytes += statSync(file).size;
}

console.log(`sync-flags: ${copied} flag(s), ${Math.round(bytes / 1024)} KB → public/flags/`);
