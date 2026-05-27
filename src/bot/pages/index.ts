/**
 * Bot pages barrel.
 *
 * Wave 3 split the bot god-file's command + callback handlers into
 * per-page modules. Each one exports a `register` function that takes
 * the grammy bot instance plus `PageDeps`. Composition root in
 * `bot/main.ts` walks the `pages` array and calls each registrar.
 */
export { registerActivityPage } from './activity.js';
export { registerBuyPage } from './buy.js';
export { registerHelpCallbackPage } from './help-callback.js';
export { registerHelpCommandPage } from './help.js';
export { registerInvitePage } from './invite.js';
export { registerLangPage } from './lang.js';
export { registerMenuPage } from './menu.js';
export { registerPlansPage } from './plans.js';
export { registerProfilePage } from './profile.js';
export { registerPromoPage } from './promo.js';
export { registerReferralPage } from './referral.js';
export { registerRulesPage } from './rules.js';
export { registerStartPage } from './start.js';
export { registerSubscriptionPage } from './subscription.js';
export { replyWithEntities } from './reply.js';
export type {
  BotContext,
  BotSession,
  BotUrls,
  PageDeps,
  PageRegistrar,
  UserLocaleSyncCache,
} from './types.js';
