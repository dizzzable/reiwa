/**
 * Object-form text for an inline button whose label is operator copy.
 *
 * Resolves the operator's `{{KEY}}` / `:slug:` tokens to glyphs and promotes a
 * LEADING premium token to `icon_custom_emoji_id` (premium owners only).
 * Inline-button captions cannot carry `custom_emoji` entities, so this is the
 * only way a pack emoji renders on one — and the only thing that keeps a raw
 * `:slug:` out of the caption.
 *
 * Moved out of `pages/start.ts` when the channel gate's join prompt stopped
 * being a `/start`-only screen: the prompt is now sent by `/start` and by the
 * gate middleware in front of every other update, and both have to resolve the
 * two button labels through this one function. The `/start` channel-gate
 * branch once carried its own copy of this while the quest deep-link and
 * payment-return branches passed `translator.t(...)` straight into grammy, so
 * the same operator label rendered on one screen and leaked `:slug:` on
 * another.
 */
import { renderButtonLabel } from '../../infrastructure/bot-config/emoji-utils.js';
import type { BotConfig } from '../../infrastructure/bot-config/types.js';

export type InlineButtonText = { text: string } | { text: string; icon_custom_emoji_id: string };

export function inlineButton(label: string, botCfg: BotConfig): InlineButtonText {
  const rendered = renderButtonLabel(
    label,
    botCfg.botEmojis,
    botCfg.customEmojis,
    botCfg.botEmojiOwnerHasPremium ?? true,
  );
  return rendered.iconCustomEmojiId !== undefined
    ? { text: rendered.text, icon_custom_emoji_id: rendered.iconCustomEmojiId }
    : { text: rendered.text };
}
