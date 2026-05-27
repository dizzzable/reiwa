/**
 * Bot pages barrel.
 *
 * Wave 3 split the bot god-file's command + callback handlers into
 * per-page modules. Each one exports a `register` function that takes
 * the grammy bot instance plus `PageDeps`. Composition root in
 * `bot/main.ts` walks the `pages` array and calls each registrar.
 */
export { registerLangPage } from './lang.js';
export type {
  BotContext,
  BotSession,
  BotUrls,
  PageDeps,
  PageRegistrar,
  UserLocaleSyncCache,
} from './types.js';
