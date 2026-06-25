/**
 * replyWithOptionalBanner — fresh-message reply that honours the operator's
 * "use one banner everywhere" setting (`bot.banner_apply_all`).
 *
 * Slash-command pages (e.g. `/help`, `/lang`) send a brand-new message with
 * `ctx.reply(...)`, which carries no banner. The welcome screen (`/start`)
 * has its own banner-send path, but every other command-triggered screen was
 * left plain — so a tester who enabled "banner everywhere" still saw no
 * banner after `/help`. Callback navigation from the welcome photo keeps the
 * banner for free (Telegram `editMessageCaption` preserves the photo), so the
 * gap is specifically the fresh command replies — which this helper closes.
 *
 * When `bannerApplyAll` is off, or no banner is configured / resolvable, it
 * degrades to a plain `ctx.reply` so a delivery is never lost.
 */
import type { InlineKeyboard } from 'grammy';

import type {
  BotContext,
  PageDeps,
} from './types.js';
import type {
  BotConfig,
  TgCustomEmojiEntity,
} from '../../infrastructure/bot-config/types.js';
import { resolveBannerSource, type BannerPhotoSource } from './banner-resolver.js';

const TELEGRAM_CAPTION_MAX = 1024;

// Telegram file_id cache for the resolved global banner, keyed by the banner
// URL. Mirrors the bounded cache `start.ts` keeps for the welcome banner so
// repeated commands don't re-download the bytes from rezeis.
const bannerFileIdCache = new Map<string, string>();

function rememberFileId(url: string, sent: unknown): string | undefined {
  const photo = (sent as { photo?: Array<{ file_id?: string }> } | undefined)?.photo;
  const fileId =
    Array.isArray(photo) && photo.length > 0 ? photo[photo.length - 1]?.file_id : undefined;
  if (typeof fileId === 'string' && fileId.length > 0) {
    if (bannerFileIdCache.size > 16) bannerFileIdCache.clear();
    bannerFileIdCache.set(url, fileId);
    return fileId;
  }
  return undefined;
}

export interface OptionalBannerReply {
  readonly text: string;
  readonly entities?: readonly TgCustomEmojiEntity[];
  readonly replyMarkup?: InlineKeyboard;
}

/**
 * Send `opts` as a fresh reply, prefixed with the global banner photo when the
 * operator enabled "banner everywhere". Falls back to a plain text reply
 * otherwise (or when the banner can't be resolved / Telegram rejects it).
 */
export async function replyWithOptionalBanner(
  ctx: BotContext,
  deps: PageDeps,
  botCfg: BotConfig,
  opts: OptionalBannerReply,
): Promise<void> {
  const entities =
    opts.entities && opts.entities.length > 0 ? [...opts.entities] : undefined;

  const visual = botCfg.visual;
  const wantBanner = visual.bannerApplyAll === true;
  const fileId = (visual.bannerFileId ?? '').trim();
  const url = (visual.bannerUrl ?? '').trim();

  if (wantBanner && (fileId.length > 0 || url.length > 0) && opts.text.length <= TELEGRAM_CAPTION_MAX) {
    // Prefer a Telegram file_id (instant, no fetch); else resolve the URL.
    let source: BannerPhotoSource | null = null;
    if (fileId.length > 0) {
      source = fileId;
    } else {
      source =
        bannerFileIdCache.get(url) ??
        (await resolveBannerSource(url, {
          rezeisAdminUrl: deps.urls.rezeisAdminUrl,
          logger: deps.logger
            ? {
                warn: (obj, msg) => {
                  deps.logger?.warn(obj as Record<string, unknown>, msg);
                },
              }
            : undefined,
        }));
    }

    if (source !== null) {
      try {
        const sent = await ctx.replyWithPhoto(source, {
          caption: opts.text,
          caption_entities: entities,
          reply_markup: opts.replyMarkup,
        });
        // Stamp the resolved file_id (URL path only) so the next command reuses
        // it and a custom banner survives without re-downloading from rezeis.
        if (fileId.length === 0 && url.length > 0 && !bannerFileIdCache.has(url)) {
          const resolved = rememberFileId(url, sent);
          if (resolved !== undefined) deps.rememberBannerFileId?.(url, resolved);
        }
        return;
      } catch (err: unknown) {
        // A stale cached file_id can 400 — drop it so the next call re-uploads.
        if (url.length > 0) bannerFileIdCache.delete(url);
        deps.logger?.warn({ err }, 'reply-with-banner: sendPhoto failed; falling back to text');
      }
    }
  }

  await ctx.reply(opts.text, { entities, reply_markup: opts.replyMarkup });
}
