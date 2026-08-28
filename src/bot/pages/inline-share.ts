/**
 * Inline mode — sharing the service from any chat.
 *
 * Typing `@<bot> …` in any chat opens the inline composer; picking the result
 * posts an invite carrying the sender's referral link. The cabinet already
 * reaches for this: `invite-link-hero.tsx` calls `switchInlineQuery` to share,
 * which until now opened a composer against a bot that answered nothing.
 *
 * Inline mode itself is enabled in @BotFather (`/setinline`) and nowhere else —
 * the Bot API has no method for it, so no panel switch can turn this on. What
 * the panel CAN do is report it: `getMe().supports_inline_queries`.
 *
 * ── Why this page is written defensively ──────────────────────────────────
 *
 * An inline query is not like the rest of this bot's traffic:
 *
 *   • It has NO CHAT. `ctx.chat` is undefined, and so is grammY's session key,
 *     which means `ctx.session` THROWS on access rather than returning empty.
 *     Nothing here touches it.
 *   • It arrives from STRANGERS. The sender may have never pressed /start and
 *     may have no account at all. Every lookup therefore has a fallback, and
 *     the answer stays useful without one.
 *   • It fires ON EVERY KEYSTROKE. So: no writes, and the referral code is
 *     memoised per user for a minute rather than fetched per character.
 *
 * ── Two rules that are not stylistic ──────────────────────────────────────
 *
 * `is_personal: true` is mandatory. The result embeds THIS sender's referral
 * code; without the flag Telegram may cache it against the query text and hand
 * one person's link to the next person who types the same thing.
 *
 * Under INVITED admission no referral link is offered at all. In that mode only
 * a single-use token admits a sign-up, so a permanent code produces a link that
 * is refused at registration — worse than no link. Minting a token here instead
 * is not an option either: this handler runs per keystroke, and minting is a
 * write against the user's invite quota. The invite hub, reached by a deliberate
 * button press, remains where a token gets minted.
 */
import { InlineKeyboard } from 'grammy';
import type { InlineQueryResultArticle } from '@grammyjs/types';

import { coerceLocale } from './coerce-locale.js';
import { isTelegramSafeButtonUrl } from '../widgets/main-keyboard.js';
import type { PageDeps, PageRegistrar } from './types.js';

/**
 * How long a resolved link is reused without asking rezeis again.
 *
 * A referral code is permanent, so this could be much longer; a minute keeps a
 * freshly-registered user from being told "open the bot first" for the rest of
 * the process's life.
 */
const LINK_CACHE_TTL_MS = 60_000;

/**
 * Telegram's own cache for the answer, per user (`is_personal`). Long enough
 * that holding a key down costs one call, short enough that a user who has just
 * registered sees their link on the next attempt rather than the next minute.
 */
const ANSWER_CACHE_SECONDS = 20;

interface ShareSummary {
  readonly referralCode?: unknown;
  readonly admissionRequiresInvite?: unknown;
}

interface CachedLink {
  readonly link: string | null;
  readonly expiresAt: number;
}

/**
 * The sender's share link, or `null` when there is nothing personal to share.
 *
 * Never throws and never writes: an inline query is a public surface and a
 * failing lookup must degrade to the plain bot link, not to an error.
 */
async function resolveShareLink(
  deps: PageDeps,
  telegramId: string,
  botUsername: string | undefined,
): Promise<string | null> {
  const summary = (await deps.adminClient?.referrals
    ?.getSummary?.({ telegramId })
    ?.catch(() => null)) as ShareSummary | null | undefined;

  // See the header: a permanent code is refused at registration in this mode,
  // and minting here would spend the user's quota on a keystroke.
  if (summary?.admissionRequiresInvite === true) return null;

  const code = typeof summary?.referralCode === 'string' ? summary.referralCode : '';
  if (code.length === 0) return null;

  // Same shape as the invite hub's link, and the same refusal to fall back to a
  // raw Telegram id: an inline result is pasted into chats and channels and
  // stays there.
  if (botUsername !== undefined && botUsername.length > 0) {
    return `https://t.me/${botUsername}?start=ref_${code}`;
  }
  return deps.urls.publicWebUrl !== null ? `${deps.urls.publicWebUrl}/ref/${code}` : null;
}

export const registerInlineSharePage: PageRegistrar = (bot, deps) => {
  const { translator, userLocale, logger } = deps;
  const linkCache = new Map<number, CachedLink>();

  bot.on('inline_query', async (ctx) => {
    const from = ctx.from;
    const telegramId = String(from.id);
    // `userLocale` is already warm: the locale middleware runs for inline
    // queries too and adopts the sender's device language. A stranger with an
    // unsupported language falls back to the default pack, which is the same
    // thing /start would do for them.
    const lang = coerceLocale(userLocale.getSync(from.id));

    try {
      const botCfg = await deps.getConfig().catch(() => null);
      const botUsername = ctx.me.username;

      let link: string | null = null;
      if (botCfg === null || botCfg.features.referralsEnabled) {
        const cached = linkCache.get(from.id);
        if (cached !== undefined && cached.expiresAt > Date.now()) {
          link = cached.link;
        } else {
          link = await resolveShareLink(deps, telegramId, botUsername);
          linkCache.set(from.id, { link, expiresAt: Date.now() + LINK_CACHE_TTL_MS });
        }
      }

      // With no personal link the result still works — it just shares the bot
      // rather than a referral. Silently answering nothing would look like a
      // broken bot to everyone in the chat.
      const isPersonalLink = link !== null;
      const shareUrl =
        link ??
        (botUsername !== undefined && botUsername.length > 0
          ? `https://t.me/${botUsername}`
          : deps.urls.publicWebUrl);

      if (shareUrl === null) {
        // No bot username and no public URL: a dev process with nothing to
        // point at. Answer empty rather than posting a broken invite.
        await ctx.answerInlineQuery([], { is_personal: true, cache_time: 0 });
        return;
      }

      const title = translator.t(
        isPersonalLink ? 'inline.share.title' : 'inline.share.title_plain',
        lang,
      );
      const description = translator.t(
        isPersonalLink ? 'inline.share.description' : 'inline.share.description_plain',
        lang,
      );
      const body = translator.t(
        isPersonalLink ? 'inline.share.message' : 'inline.share.message_plain',
        lang,
      );

      const keyboard = isTelegramSafeButtonUrl(shareUrl)
        ? new InlineKeyboard().url(translator.t('inline.share.open', lang), shareUrl)
        : undefined;

      const result: InlineQueryResultArticle = {
        type: 'article',
        // Varies with the link so a cached result can never outlive the state
        // it was built from — a user who registers mid-session would otherwise
        // keep being offered the anonymous variant from Telegram's cache.
        id: isPersonalLink ? 'share-referral' : 'share-plain',
        title,
        description,
        input_message_content: {
          message_text: `${body}\n\n${shareUrl}`,
          link_preview_options: { is_disabled: false },
        },
        ...(keyboard !== undefined ? { reply_markup: keyboard } : {}),
      };

      await ctx.answerInlineQuery([result], {
        // NOT optional — see the header. The result carries this sender's own
        // referral code.
        is_personal: true,
        cache_time: ANSWER_CACHE_SECONDS,
        // Strangers get a way in. `start_parameter` is what makes the button
        // open the bot rather than merely mention it.
        ...(isPersonalLink
          ? {}
          : { button: { text: translator.t('inline.share.start', lang), start_parameter: 'inline' } }),
      });
    } catch (err: unknown) {
      // Swallowed on purpose. `bot.catch` apologises by replying into a chat,
      // and an inline query has none — the apology would fail and mask this.
      // An unanswered inline query simply shows nothing in the composer.
      logger?.warn({ err, telegramId }, 'bot/inline: failed to answer inline query');
    }
  });
};
