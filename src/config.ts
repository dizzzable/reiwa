/**
 * @deprecated Re-export shim for back-compat during the clean-architecture
 * migration. All new code imports from `./core/config/index.js` directly;
 * this file disappears once the bot/api/worker callers are migrated in
 * Wave 2-4.
 */
export { loadConfig, resolveRezeisAdminUrl, resolveReiwaPublicUrl } from './core/config/index.js';
export type { ReiwaConfig } from './core/config/index.js';
