/**
 * CountryFlag — a real flag on every platform, or an honest badge.
 *
 * WHY NOT THE EMOJI. `🇨🇿` is two regional-indicator code points, and Windows
 * ships no font that draws the pair as a flag — every desktop browser there
 * renders the letters "CZ" instead. The phone draws it, the desktop does not,
 * and a screen that shows both looks broken on half its audience. The SVGs come
 * from `flag-icons` (MIT) and are copied into `public/flags/` by
 * `scripts/sync-flags.mjs`.
 *
 * WHY A BADGE IS STILL HERE. Not every code has a flag, and the ones that do
 * not are ordinary rather than exceptional: `EU` on a load balancer has a flag
 * file, but an operator can write any two letters, and a server with no country
 * at all has none. Those get the code in a small monospace badge — which is
 * what the broken emoji already looked like, except deliberate.
 *
 * The file is fetched only when a flag is actually on screen, so a customer
 * pays for the six their operator uses and not for the other two hundred.
 */
import { useState } from 'react';

import { cn } from '@/lib/utils';

export interface CountryFlagProps {
  /** ISO 3166-1 alpha-2, in either case. `null` when nothing is known. */
  readonly code: string | null;
  /**
   * Extra classes for the outer box. Sizing lives here — and a caller that
   * passes none still gets a reserved box from the default, because a lazy
   * image with no dimensions lays out 0x0 and then shoves the list down the
   * page when the bytes land.
   */
  readonly className?: string;
}

/** Two letters, nothing else — an operator can write anything in a name. */
const CODE_PATTERN = /^[A-Za-z]{2}$/;

export function CountryFlag({ code, className = 'size-8' }: CountryFlagProps) {
  const [failed, setFailed] = useState(false);
  const normalized = code !== null && CODE_PATTERN.test(code) ? code.toUpperCase() : null;

  if (normalized === null || failed) {
    return (
      <span
        className={cn(
          'grid place-items-center rounded-[3px] bg-white/[0.08] text-[9px] font-semibold tracking-[0.08em] text-muted-foreground tabular-nums',
          className,
        )}
        aria-hidden="true"
      >
        {normalized ?? '··'}
      </span>
    );
  }

  return (
    <img
      // `BASE_URL` rather than a leading slash: the cabinet can be served from a
      // sub-path, and a hard `/flags/…` would 404 there — silently, into the
      // badge below, which is the failure that looks like no failure at all.
      src={`${import.meta.env.BASE_URL}flags/${normalized.toLowerCase()}.svg`}
      // Decorative: the server's name says where it is, in words, right beside
      // this. A reader hearing "flag of Czechia, Czech" has been told twice.
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      // A code with no file — an operator's own two letters, a territory the set
      // does not carry — lands on the badge instead of a broken-image icon.
      onError={() => setFailed(true)}
      // `aspect-[4/3]` is the flag's own shape, and it reserves the box even
      // for a caller that gives a width and no height. Every flag in the set
      // is 4:3, so this crops nothing.
      className={cn('aspect-[4/3] rounded-[3px] object-cover ring-1 ring-white/10', className)}
    />
  );
}

/**
 * The operator's server name with its leading flag emoji taken off.
 *
 * The name is shown beside {@link CountryFlag}, which already draws that flag
 * properly. Left in, the emoji is drawn twice on a phone and — on Windows,
 * where it has no glyph — appears as two stray letters in front of the name:
 * "cz Czech". Only a leading or trailing flag is removed, and only the emoji
 * itself; everything the operator typed as words is untouched.
 */
const EDGE_FLAG = /^\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*|\s*[\u{1F1E6}-\u{1F1FF}]{2}\s*$/gu;

export function nameWithoutFlag(name: string): string {
  const stripped = name.replace(EDGE_FLAG, '').trim();
  // A name that is NOTHING but a flag keeps it: an empty row is worse than a
  // duplicated one, and this is what an operator who names hosts `🇩🇪` gets.
  return stripped.length > 0 ? stripped : name.trim();
}
