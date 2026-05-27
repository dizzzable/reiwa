/**
 * Re-export shim for the legacy `./types` import path used by `bot/main.ts`.
 *
 * Wave 3-prep relocated bot-config DTOs to
 * `src/infrastructure/bot-config/types.ts`. This file preserves the old
 * import path so `bot/main.ts` keeps compiling untouched until Wave 3
 * rewrites the bot god-file on top of DI.
 *
 * Anything new should import from
 * `@/infrastructure/bot-config/types` (or the barrel
 * `@/infrastructure/bot-config`).
 */
export * from '../infrastructure/bot-config/types.js';
