/**
 * Re-export shim for the legacy `./message-builder` import path used by
 * `bot/main.ts`.
 *
 * Wave 3-prep relocated message builders to
 * `src/../infrastructure/bot-config/types.jsture/bot-message/message-builder.ts`. New callers
 * import from `@/infrastructure/bot-message`.
 */
export * from '../infrastructure/bot-message/message-builder.js';
