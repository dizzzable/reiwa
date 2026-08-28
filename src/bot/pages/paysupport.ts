/**
 * `/paysupport` — the payment-questions door.
 *
 * Telegram expects a bot that takes payments to answer this command, and it has
 * been advertised in our `/` autocomplete since `BOT_COMMANDS` was written —
 * with no handler anywhere. Tapping it did nothing: the AI-support catch-all
 * (`bot.hears`) drops anything starting with `/`.
 *
 * Our payments are panel-side, so there is no refund flow to run here. What the
 * command owes the user is a way to reach a human about a charge, which is what
 * it now does.
 *
 * ── Why not just alias `/help` ────────────────────────────────────────────
 *
 * Because the two commands promise different things. `/help` is "how do I use
 * this"; `/paysupport` is "money left my account". Pointing both at the same
 * screen would make the second one indistinguishable from the first, and the
 * person typing it has a more specific problem — hence its own copy, and a
 * prefill that says so, so support opens the chat already knowing the subject.
 *
 * The support handle itself is resolved by `resolveConfiguredSupportUrl`, the
 * shared resolver the main keyboard and screen `support_url` buttons use, so
 * this command can never point somewhere the rest of the bot does not.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { replyWithOptionalBanner } from './reply-with-banner.js';
import { renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import { resolveConfiguredSupportUrl } from '../widgets/main-keyboard.js';
import type { PageRegistrar } from './types.js';

export const registerPaySupportPage: PageRegistrar = (bot, deps) => {
  bot.command('paysupport', async (ctx) => {
    const lang = coerceLocale(deps.userLocale.getSync(ctx.from?.id ?? 0));
    const botCfg = await deps.getConfig();

    const supportUrl = resolveConfiguredSupportUrl(
      botCfg.visual.supportUsername,
      deps.envSupportUsername,
      deps.translator.t('paysupport.prefill', lang),
    );

    const kb = new InlineKeyboard();
    if (supportUrl !== null) {
      // The same system button the help screens render, through the same
      // resolver — otherwise an operator's `:slug:` icon shows on one screen
      // and leaks raw on this one.
      const contact = renderSystemButton(
        deps.translator.t('help.contact_button', lang),
        'help_contact',
        botCfg,
      );
      kb.url(
        contact.iconCustomEmojiId !== undefined
          ? { text: contact.text, icon_custom_emoji_id: contact.iconCustomEmojiId }
          : contact.text,
        supportUrl,
      ).row();
    }
    const back = renderSystemButton(deps.translator.t('back_to_menu', lang), 'back', botCfg);
    kb.text(
      back.iconCustomEmojiId !== undefined
        ? { text: back.text, icon_custom_emoji_id: back.iconCustomEmojiId }
        : back.text,
      'menu:main',
    );

    // Separate copy for the no-contact case. Telling someone with a payment
    // problem to "write to support" above a screen with no way to write to
    // support is worse than admitting the handle is not configured.
    const body =
      supportUrl !== null
        ? deps.translator.t('paysupport.body', lang)
        : deps.translator.t('paysupport.unavailable', lang);

    await replyWithOptionalBanner(ctx, deps, botCfg, { text: body, replyMarkup: kb });
  });
};
