/**
 * Banner store stub (Wave 1B → Wave 6).
 *
 * Wave 6 will land the real implementation: a `BannerStore` class that
 * walks the 5-step lookup chain documented on `BannerStorePort` (DB
 * `bot.banner.<name>[.<lang>]` overrides, then filesystem
 * `assets/banners/<lang>/<name>.{ext}`, then locale `default`, then
 * the global `default`). The constructor will take an injected
 * `BotTextRepository` and an `assetsRoot` path.
 *
 * For now this module exports a no-op implementation that always
 * resolves to `null` — the call site (Wave 3 bot pages) skips banners
 * gracefully when the resource is missing, so wiring this up early
 * does not regress UX.
 */
export { NoopBannerStore } from './noop-banner-store.js';
