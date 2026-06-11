/**
 * Bot pages barrel.
 *
 * Wave A (v0.5.0) pruned the bot down to its essential role: an entry
 * point into the web cabinet plus a delivery channel for admin-side
 * notifications. The bot does NOT replicate cabinet UX — no sub /
 * plan / promo / activity / referral-stats screens. Those all live in
 * the SPA / Mini App.
 *
 * What stays:
 *  - `start`     — `/start` welcome + main keyboard (cabinet entry).
 *  - `menu`      — `back_to_menu` + `check_channel` callbacks.
 *  - `help-callback` — fallback help screen when support_url is
 *                       unconfigured (the keyboard's Помощь button is
 *                       a `support_url` direct deep-link by default).
 *  - `help`      — `/help` slash-command surfacing the same fallback.
 *  - `invite`    — `invite` callback emitting the share link;
 *                   stats card lives in the cabinet.
 *  - `rules`     — `rules` callback rendering admin-managed rules
 *                   screen with a back-to-menu CTA.
 *  - `lang`      — `/lang` callback picker for the user's locale
 *                   (admin-managed translations follow the choice).
 *  - `dynamic-screen` — universal `screen:<shortId>` callback that
 *                   resolves an admin-defined BotFlow screen.
 */
export { registerDynamicScreenPage } from './dynamic-screen.js';
export { registerClosePage } from './close.js';
export { registerHelpCallbackPage } from './help-callback.js';
export { registerHelpCommandPage } from './help.js';
export { registerInvitePage } from './invite.js';
export { registerLangPage } from './lang.js';
export { registerMenuPage } from './menu.js';
export { registerRulesPage } from './rules.js';
export { registerStartPage } from './start.js';
export { replyWithEntities } from './reply.js';
export type {
  BotContext,
  BotSession,
  BotUrls,
  PageDeps,
  PageRegistrar,
  UserLocaleSyncCache,
} from './types.js';
