/**
 * Banner store (Wave 1B → Wave 6).
 *
 * Wave 6 lands the real implementation: a `BannerStore` class that
 * walks the documented 5-step lookup chain (DB
 * `bot.banner.<name>[.<lang>]` overrides via the supplied
 * `getOverride` callback, then filesystem
 * `assets/banners/<lang>/<name>.<ext>`, then locale `default`, then
 * the global `default`). Constructor takes the `assetsRoot` path and
 * a callback into the bot-config translations cache; the store stays
 * decoupled from the AdminClient and from any DB driver.
 *
 * `NoopBannerStore` is kept exported as a test seam — use it when
 * callers want to exercise downstream code without a real assets
 * folder on disk.
 */
export { BannerStore, type BannerStoreOptions, type GetOverride } from './banner-store.js';
export { NoopBannerStore } from './noop-banner-store.js';
