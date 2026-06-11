/**
 * Bot-message barrel.
 *
 * Pure builders that turn admin-managed bot-config DTOs into Telegram
 * `sendMessage`-shaped payloads (text + entities). No grammy / network
 * coupling — message builders are easy to unit-test by feeding a
 * synthetic `BotConfig` + a stub translator.
 */
export {
  buildProfileSummary,
  type ProfileSummaryParams,
} from './message-builder.js';
