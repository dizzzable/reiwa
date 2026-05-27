/**../infrastructure/bot-config/types.js
 * Re-export shim for the legacy `./emoji-utils` import path used by
 * `bot/main.ts`.
 *
 * Wave 3-prep relocated emoji helpers to
 * `src/infrastructure/bot-config/emoji-utils.ts`. This file preserves
 * the old import path; new callers import from
 * `@/infrastructure/bot-config`.
 */
export * from '../infrastructure/bot-config/emoji-utils.js';
