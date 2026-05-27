/**
 * Well-known banner pages reiwa renders.
 *
 * Each value identifies a logical bot/web "page" that may have a custom
 * banner image attached. The banner-store performs a 5-step lookup chain
 * (snoups-style) per page:
 *
 *   1. DB  `bot.banner.<name>.<lang>`   ← admin override
 *   2. DB  `bot.banner.<name>`          ← admin without locale
 *   3. FS  `assets/banners/<lang>/<name>.{ext}`
 *   4. FS  `assets/banners/<lang>/default.{ext}`
 *   5. FS  `assets/banners/default.{ext}`
 *
 * Names are stable strings — operators see them in the admin Bot-Texts
 * editor under the `bot.banner.*` namespace.
 */
export const BANNER_NAMES = [
  'default',
  'menu',
  'dashboard',
  'subscription',
  'promocode',
  'referral',
] as const;
export type BannerName = (typeof BANNER_NAMES)[number];

/**
 * Image formats the banner-store recognises on the filesystem leg of the
 * lookup chain. Operators can override with any HTTP URL via the DB so
 * formats outside this list still work — they just are not auto-resolved
 * from `assets/banners/*`.
 */
export const BANNER_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const;
export type BannerFormat = (typeof BANNER_FORMATS)[number];
