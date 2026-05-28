/**
 * Rules callback page.
 *
 * STEALTHNET-style sub-menu rendered in place via `editOrReply`:
 *   • Rules-link present  → URL button "📜 Открыть правила"
 *   • Rules-link missing  → fallback URL button to support so users
 *                           still have a recourse path
 *   • Always              → "◀️ В меню" footer (callback menu:main)
 *
 * The rules link is sourced from rezeis-admin's platform policy
 * endpoint (the same way subscription/channel-required policy is
 * read elsewhere). Failures are non-fatal — a degraded "rules
 * unavailable" copy is preferable to a dead button.
 */
import { InlineKeyboard } from 'grammy';

import { coerceLocale } from './coerce-locale.js';
import { editOrReply } from './edit-message.js';
import {
  buildScreenKeyboard,
  findScreenByName,
  pickScreenText,
} from './screen-renderer.js';
import type { PageRegistrar } from './types.js';

interface PlatformPolicyMaybeRulesLink {
  readonly rulesLink?: string | null;
}

const NUMERIC_HANDLE = /^-?\d+$/;
const SCREEN_OVERRIDE_NAME = 'rules';

export const registerRulesPage: PageRegistrar = (bot, deps) => {
  const {
    adminClient,
    translator,
    userLocale,
    getConfig,
    envSupportUsername,
    urls,
  } = deps;

  bot.callbackQuery('rules', async (ctx) => {
    await ctx.answerCallbackQuery();
    const lang = coerceLocale(userLocale.getSync(ctx.from?.id ?? 0));
    const backLabel = translator.t('back_to_menu', lang);
    const botCfg = await getConfig();

    // Operator override: a screen named "rules" replaces the built-in
    // platform-policy fetch.
    const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
    if (overrideScreen !== null) {
      const text = pickScreenText(overrideScreen, lang);
      const keyboard = buildScreenKeyboard(
        overrideScreen,
        lang,
        urls.publicWebUrl,
        urls.miniAppUrl,
      );
      if (overrideScreen.buttons.length === 0) {
        keyboard.text(backLabel, 'menu:main');
      }
      await editOrReply(ctx, { text, replyMarkup: keyboard });
      return;
    }

    const policy = adminClient
      ? ((await adminClient.system.getPlatformPolicy().catch(() => null)) as
          | PlatformPolicyMaybeRulesLink
          | null)
      : null;
    const link = (policy?.rulesLink ?? '').trim();

    if (link.length > 0) {
      const kb = new InlineKeyboard()
        .url(translator.t('rules.open_button', lang), link)
        .row()
        .text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('rules.intro', lang),
        replyMarkup: kb,
      });
      return;
    }

    // No rules link configured — fall back to "Contact support" so the
    // screen still has a useful CTA instead of a dead end.
    const adminHandle = botCfg.visual.supportUsername.replace(/^@+/, '').trim();
    const handle =
      adminHandle.length > 0 ? adminHandle : (envSupportUsername ?? '').trim();

    if (handle.length > 0 && !NUMERIC_HANDLE.test(handle)) {
      const prefill = translator.t('help.contact_prefill', lang);
      const supportUrl = `https://t.me/${encodeURIComponent(handle)}?text=${encodeURIComponent(prefill)}`;
      const kb = new InlineKeyboard()
        .url(translator.t('help.contact_button', lang), supportUrl)
        .row()
        .text(backLabel, 'menu:main');
      await editOrReply(ctx, {
        text: translator.t('rules.unavailable', lang),
        replyMarkup: kb,
      });
      return;
    }

    const kb = new InlineKeyboard().text(backLabel, 'menu:main');
    await editOrReply(ctx, {
      text: translator.t('rules.unavailable', lang),
      replyMarkup: kb,
    });
  });
};
