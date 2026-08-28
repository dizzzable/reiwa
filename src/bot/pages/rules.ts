/**
 * Rules screen — reachable two ways: the `rules` keyboard callback and the
 * `/rules` slash command.
 *
 * Both doors were advertised long before both existed. `/rules` has been in
 * `BOT_COMMANDS` — and therefore in Telegram's `/` autocomplete — with no
 * handler at all: it fell through to the AI-support catch-all, which drops
 * anything starting with `/`. So the command appeared in the menu and did
 * nothing when tapped.
 *
 * The screen is operator-editable, so the two entry points share ONE builder
 * (`buildRulesView`) and differ only in DELIVERY:
 *
 *   • the callback edits the current message in place (STEALTHNET-style), the
 *     way every other sub-menu navigation does;
 *   • the command sends a fresh message, because there is nothing to edit —
 *     `editOrReply` would aim `editMessageText` at the user’s own `/rules`
 *     message and Telegram refuses that.
 *
 * Two copies of the body would have been the obvious shortcut and the wrong
 * one: the operator edits this screen in Bot Studio, and a second copy drifts
 * the moment one of them learns about a placeholder the other does not.
 *
 * Operator override contract (template + system buttons):
 *   • The screen *text* may be edited in Bot Studio — operator
 *     creates / edits a screen named "rules", types whatever copy
 *     they want. Placeholder supported:
 *         {{rulesLink}}   — admin-configured URL or empty
 *   • System buttons (rules URL when the operator has configured
 *     a `rulesLink` in the platform policy, plus the back-to-menu
 *     row) are appended by the bot. NOT a contact-support fallback —
 *     operators who want one can add it explicitly via the screen’s
 *     custom-button list. Surprise CTAs were the wrong contract.
 *
 * Rules-link source: rezeis-admin’s platform policy endpoint (same
 * channel-required / subscription-info policy used elsewhere).
 * Failures are non-fatal — a degraded "rules unavailable" copy is
 * preferable to a dead button.
 */
import { InlineKeyboard } from 'grammy';

import { getLegalDocumentsCache } from '../../infrastructure/admin-client/legal-documents-cache.js';
import { getPolicyCache } from '../../infrastructure/admin-client/policy-cache.js';
import { resolveConfiguredSupportUrl } from '../widgets/main-keyboard.js';
import { coerceLocale } from './coerce-locale.js';
import { renderScreenOrEdit } from './screen-banner.js';
import { replyWithOptionalBanner } from './reply-with-banner.js';
import { renderBotCopy, renderBotCopyHtml, renderSystemButton } from '../../infrastructure/bot-config/emoji-utils.js';
import {
  applyScreenTemplate,
  appendBackToMenuRow,
  buildScreenKeyboard,
  findScreenByName,
} from './screen-renderer.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';
import type { BotConfig, BotScreen, TgCustomEmojiEntity } from '../../infrastructure/bot-config/types.js';
import type { PageDeps, PageRegistrar } from './types.js';

const SCREEN_OVERRIDE_NAME = 'rules';

/**
 * Everything the rules screen consists of, resolved but not yet delivered.
 *
 * `botCfg` rides along because both callers need it for their own delivery
 * step — asking for it twice would mean two cache reads that can disagree
 * mid-render.
 */
interface RulesView {
  readonly botCfg: BotConfig;
  readonly overrideScreen: BotScreen | null;
  readonly text: string;
  readonly entities?: readonly TgCustomEmojiEntity[];
  readonly parseMode?: 'HTML';
  readonly replyMarkup: InlineKeyboard;
}

async function buildRulesView(deps: PageDeps, lang: SupportedLocale): Promise<RulesView> {
  const { adminClient, translator, getConfig, urls } = deps;
  const backLabel = translator.t('back_to_menu', lang);
  const botCfg = await getConfig();

  const policy = adminClient
    ? await getPolicyCache(adminClient).get().catch(() => null)
    : null;
  // The operator's documents win over the legacy external link. Both are
  // "the rules" from a user’s point of view, and having the bot point
  // somewhere else than the sign-up form did is how the two quietly diverge.
  //
  // Why a LINK and not the text itself: a document is capped at 40 000
  // characters and a Telegram message at ~4096. Paginating a legal text
  // across messages is worse than one button to a page that scrolls, so the
  // bot sends the reader to the cabinet's public `/legal` page.
  //
  // `rulesLink` stays as the fallback for installs that have not filled the
  // documents in yet — removing it would blank a screen operators rely on.
  // Through the cache, not straight to the panel. `AdminTransport` runs one
  // 50-connection pool for everything the bot does, and an uncached call here
  // has no timeout of its own — only the transport's 10s. While the panel is
  // slow every tap on this screen parks a connection that checkout also needs.
  // The cache mirrors `PolicyCache` read two lines above: TTL, single-flight,
  // last-known-good, and it returns an empty list rather than throwing.
  //
  // try/catch around it anyway: an older admin-client may not carry the
  // namespace at all, and a missing property throws synchronously before any
  // promise exists.
  let activeDocuments: readonly { readonly key: string }[] = [];
  try {
    activeDocuments = adminClient ? await getLegalDocumentsCache(adminClient).get(lang) : [];
  } catch {
    activeDocuments = [];
  }
  const publicWebUrl = (urls.publicWebUrl ?? '').trim();
  const documentsLink =
    activeDocuments.length > 0 && publicWebUrl.length > 0
      ? `${publicWebUrl.replace(/\/+$/, '')}/legal`
      : '';
  const link = documentsLink || (policy?.rulesLink ?? '').trim();

  // Resolve text — operator override wins, otherwise i18n default.
  const overrideScreen = findScreenByName(botCfg.screens, SCREEN_OVERRIDE_NAME);
  const fallbackText =
    link.length > 0
      ? translator.t('rules.intro', lang)
      : translator.t('rules.unavailable', lang);
  const text = overrideScreen
    ? applyScreenTemplate(overrideScreen, lang, { rulesLink: link })
    : fallbackText;

  // Operator’s own custom buttons (if any) render FIRST; system buttons
  // (rules URL + back) are appended below. Previously custom buttons were
  // dropped whenever the rules screen added its system buttons.
  const hasCustomButtons = (overrideScreen?.buttons.length ?? 0) > 0;
  const kb = overrideScreen
    ? buildScreenKeyboard(overrideScreen, lang, urls.publicWebUrl, urls.miniAppUrl, {
        botEmojis: botCfg.botEmojis,
        customEmojis: botCfg.customEmojis,
        ownerHasPremium: botCfg.botEmojiOwnerHasPremium,
        supportUrl: resolveConfiguredSupportUrl(
          botCfg.visual.supportUsername,
          deps.envSupportUsername,
          translator.t('help.contact_prefill', lang),
        ),
      })
    : new InlineKeyboard();

  if (link.length > 0) {
    if (hasCustomButtons) kb.row();
    const open = renderSystemButton(translator.t('rules.open_button', lang), 'rules_open', botCfg);
    kb.url(
      open.iconCustomEmojiId !== undefined
        ? { text: open.text, icon_custom_emoji_id: open.iconCustomEmojiId }
        : open.text,
      link,
    );
  }
  const back = renderSystemButton(backLabel, 'back', botCfg);
  appendBackToMenuRow(kb, back.text, back.iconCustomEmojiId);

  // `{{KEY}}` + `:slug:` → premium custom-emoji (operator-managed); unicode
  // fallback for bots without the capability is handled by Telegram. HTML
  // screens render the operator’s markup via parse_mode instead of entities.
  if (overrideScreen?.parseMode === 'html') {
    return {
      botCfg,
      overrideScreen,
      text: renderBotCopyHtml(text, botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium),
      parseMode: 'HTML',
      replyMarkup: kb,
    };
  }
  const rendered = renderBotCopy(text, botCfg.botEmojis, botCfg.customEmojis, botCfg.botEmojiOwnerHasPremium);
  return {
    botCfg,
    overrideScreen,
    text: rendered.text,
    entities: rendered.entities,
    replyMarkup: kb,
  };
}

export const registerRulesPage: PageRegistrar = (bot, deps) => {
  const { userLocale } = deps;
  const localeOf = (id: number | undefined): SupportedLocale =>
    coerceLocale(userLocale.getSync(id ?? 0));

  bot.callbackQuery('rules', async (ctx) => {
    await ctx.answerCallbackQuery();
    const view = await buildRulesView(deps, localeOf(ctx.from?.id));
    await renderScreenOrEdit(ctx, deps, view.botCfg.visual, {
      overrideScreen: view.overrideScreen,
      text: view.text,
      ...(view.entities !== undefined ? { entities: view.entities } : {}),
      ...(view.parseMode !== undefined ? { parseMode: view.parseMode } : {}),
      replyMarkup: view.replyMarkup,
    });
  });

  // A fresh message, not an edit. There is no previous screen to replace, and
  // `editOrReply` would target the message the user just sent.
  bot.command('rules', async (ctx) => {
    const view = await buildRulesView(deps, localeOf(ctx.from?.id));
    await replyWithOptionalBanner(ctx, deps, view.botCfg, {
      text: view.text,
      ...(view.entities !== undefined ? { entities: view.entities } : {}),
      ...(view.parseMode !== undefined ? { parseMode: view.parseMode } : {}),
      replyMarkup: view.replyMarkup,
    });
  });
};
