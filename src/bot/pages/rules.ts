/**
 * Rules callback page.
 *
 * STEALTHNET-style sub-menu rendered in place via `editOrReply`.
 *
 * Operator override contract (template + system buttons):
 *   • The screen *text* may be edited in Bot Studio — operator
 *     creates / edits a screen named "rules", types whatever copy
 *     they want. Placeholder supported:
 *         {{rulesLink}}   — admin-configured URL or empty
 *   • System buttons (rules URL when the operator has configured
 *     a `rulesLink` in the platform policy, plus the back-to-menu
 *     row) are appended by the bot. NOT a contact-support fallback —
 *     operators who want one can add it explicitly via the screen's
 *     custom-button list. Surprise CTAs were the wrong contract.
 *
 * Rules-link source: rezeis-admin's platform policy endpoint (same
 * channel-required / subscription-info policy used elsewhere).
 * Failures are non-fatal — a degraded "rules unavailable" copy is
 * preferable to a dead button.
 */
import { InlineKeyboard } from 'grammy';

import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import { resolvePlaceholders } from '../../infrastructure/bot-config/emoji-utils.js';
import {
  applyScreenTemplate,
  appendBackToMenuRow,
  findScreenByName,
} from './screen-renderer.js';
import type { PageRegistrar } from './types.js';

const SCREEN_OVERRIDE_NAME = 'rules';

export const registerRulesPage: PageRegistrar = (bot, deps) => {
  const { adminClient, translator, userLocale, getConfig } = deps;

  bot.callbackQuery('rules', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);
    const botCfg = await getConfig();

    const policy = adminClient
      ? await getPolicyCache(adminClient).get().catch(() => null)
      : null;
    const link = (policy?.rulesLink ?? '').trim();

    // Resolve text — operator override wins, otherwise i18n default.
    const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
    const fallbackText =
      link.length > 0
        ? translator.t('rules.intro', lang)
        : translator.t('rules.unavailable', lang);
    const text = overrideScreen
      ? applyScreenTemplate(overrideScreen, lang, { rulesLink: link })
      : fallbackText;
    // `{{KEY}}` → premium custom-emoji (operator-managed); unicode fallback for
    // bots without the capability is handled by Telegram automatically.
    const rendered = resolvePlaceholders(text, botCfg.botEmojis);

    if (link.length > 0) {
      const kb = new InlineKeyboard().url(
        translator.t('rules.open_button', lang),
        link,
      );
      appendBackToMenuRow(kb, backLabel);
      await editOrReply(ctx, { text: rendered.text, entities: rendered.entities, replyMarkup: kb });
      return;
    }

    const kb = new InlineKeyboard().text(backLabel, 'menu:main');
    await editOrReply(ctx, { text: rendered.text, entities: rendered.entities, replyMarkup: kb });
  });
};
