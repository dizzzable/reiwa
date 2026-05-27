import type { BannerName } from '../../core/enums/banner-name.enum.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

/**
 * Resolved banner asset.
 *
 *  - `kind: 'url'`   external URL (operator override from
 *                    `BotText.bot.banner.<page>[.<lang>]`).
 *  - `kind: 'file'`  local path under `assets/banners/...` that the bot
 *                    sends via `replyWithPhoto({ source: path })`.
 */
export type BannerResource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string };

/**
 * Resolves the banner image to send before a given page (e.g. menu,
 * dashboard, subscription).
 *
 * The 5-step lookup chain is the implementation's responsibility:
 *   1. DB  `bot.banner.<name>.<lang>`   ← admin override
 *   2. DB  `bot.banner.<name>`          ← admin without locale
 *   3. FS  `assets/banners/<lang>/<name>.{ext}`
 *   4. FS  `assets/banners/<lang>/default.{ext}`
 *   5. FS  `assets/banners/default.{ext}`
 *
 * Returns `null` when none of the steps yields a usable asset; callers
 * skip the banner gracefully (no error to the end user).
 */
export interface BannerStorePort {
  resolve(name: BannerName, lang: SupportedLocale): Promise<BannerResource | null>;
}
