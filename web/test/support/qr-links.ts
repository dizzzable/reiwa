/**
 * The links the cabinet puts into a code that may carry a logo, at the lengths
 * they really come in — for the logo planner's sweep and its decode sweep, so
 * both judge the same inputs.
 *
 * Shapes, from the code that builds them:
 *   - referral invite  `https://<REIWA_DOMAIN>/register?ref=<cuid>` — 66–74 bytes
 *     for a 19–27-character host (`invite-link-hero.tsx`);
 *   - web ad           `https://<REIWA_DOMAIN>/?campaign=ad_<10>` — 51–77 bytes;
 *   - bot ad           `https://t.me/<bot>?start=ad_<10>` — 38–65 bytes, a bot
 *     username being 5–32 characters and ending in `bot`;
 *   - a web ad with UTM parameters an operator appended — 92 bytes, the longest.
 *
 * Every length is asserted, so a fixture edit cannot quietly move a link into
 * another symbol version.
 */

/** A Prisma `cuid()` — the referral code. */
const CUID = 'clx8k2m9q0000a1b2c3d4e5f6'
/** `ad_` + ten characters — the advertising payload. */
const AD = 'ad_aB3dE6gH9k'

function exactly(bytes: number, link: string): string {
  const actual = new TextEncoder().encode(link).length
  if (actual !== bytes) throw new Error(`fixture "${link}" is ${actual} bytes, not ${bytes}`)
  return link
}

/** A host of `length` characters under `.example.com`. */
function host(length: number): string {
  const suffix = '.example.com'
  return `${'cabinet-brand-vpn-service-for-everyone-anywhere'.slice(0, length - suffix.length)}${suffix}`
}

/** A bot username of `length` characters, ending in `bot`. */
function bot(length: number): string {
  return `${'my_vpn_service_brand_for_everyone'.slice(0, length - 3)}bot`
}

export const LOGO_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['referral 66 B', exactly(66, `https://${host(19)}/register?ref=${CUID}`)],
  ['referral 70 B', exactly(70, `https://${host(23)}/register?ref=${CUID}`)],
  ['referral 74 B', exactly(74, `https://${host(27)}/register?ref=${CUID}`)],
  ['web ad 51 B', exactly(51, `https://${host(19)}/?campaign=${AD}`)],
  ['web ad 60 B', exactly(60, `https://${host(28)}/?campaign=${AD}`)],
  ['web ad 64 B', exactly(64, `https://${host(32)}/?campaign=${AD}`)],
  ['web ad 70 B', exactly(70, `https://${host(38)}/?campaign=${AD}`)],
  ['web ad 77 B', exactly(77, `https://${host(45)}/?campaign=${AD}`)],
  ['bot ad 38 B', exactly(38, `https://t.me/${bot(5)}?start=${AD}`)],
  ['bot ad 45 B', exactly(45, `https://t.me/${bot(12)}?start=${AD}`)],
  ['bot ad 52 B', exactly(52, `https://t.me/${bot(19)}?start=${AD}`)],
  ['bot ad 58 B', exactly(58, `https://t.me/${bot(25)}?start=${AD}`)],
  ['bot ad 65 B', exactly(65, `https://t.me/${bot(32)}?start=${AD}`)],
  [
    'web ad + UTM 92 B',
    exactly(92, `https://${host(19)}/?campaign=${AD}&utm_source=telegram&utm_campaign=partner`),
  ],
]

/** The referral link the research numbers were measured on: 66 bytes, version 5 at M. */
export const REFERRAL_66 = LOGO_LINKS[0]![1]
