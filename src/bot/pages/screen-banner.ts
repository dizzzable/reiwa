/**
 * Per-screen banner rendering for dynamic sub-screens.
 *
 * The dynamic-screen handler renders an operator-configured screen in
 * response to a `screen:<shortId>` callback. Historically it edited the
 * text in place (`editOrReply`), which silently dropped any banner — you
 * can't turn a text message into a photo with `editMessageText`.
 *
 * This module closes that gap. It resolves the banner a screen should
 * show (the screen's own photo media, or — when the operator enabled
 * "one banner for all screens" — the global bot banner) and renders the
 * screen with the cheapest Telegram primitive that works for the current
 * message type:
 *
 *   • banner + current message already a photo → `editMessageMedia`
 *     (swap photo + caption + keyboard in place, no flicker).
 *   • banner + current message is text          → delete + `sendPhoto`
 *     (Telegram can't morph a text message into a photo).
 *
 * When no banner is desired the caller keeps its plain `editOrReply`
 * text path (so a screen reached from the welcome photo just edits the
 * caption instead of flickering through a delete+resend).
 *
 * Banner bytes are resolved through the shared `banner-resolver`
 * (file_id / absolute URL pass through; relative `/uploads/...` are
 * fetched from rezeis and re-uploaded). Resolved Telegram `file_id`s are
 * cached per source so repeated navigation doesn't re-download.
 */
import { InputMediaBuilder, type Context, type InlineKeyboard } from 'grammy';

import type {
  BotScreen,
  BotVisualConfig,
  TgEntity,
} from '../../infrastructure/bot-config/types.js';
import { resolveBannerSource, type BannerPhotoSource } from './banner-resolver.js';

const TELEGRAM_CAPTION_MAX = 1024;

export interface ScreenBannerDeps {
  readonly rezeisAdminUrl: string | null;
  readonly logger?: { warn: (obj: unknown, msg: string) => void };
}

/**
 * Resolve the raw banner reference a screen should display: its own photo
 * media first, then the global banner when "apply to all" is enabled, else
 * `null`. Only photo media counts as a banner — video / document / animation
 * keep the legacy text render.
 */
export function resolveScreenBannerRef(
  screen: BotScreen,
  visual: BotVisualConfig,
): string | null {
  if (screen.mediaType === 'photo') {
    const fileId = (screen.mediaFileId ?? '').trim();
    if (fileId.length > 0) return fileId;
    const url = (screen.mediaUrl ?? '').trim();
    if (url.length > 0) return url;
  }
  if (visual.bannerApplyAll === true) {
    const globalFileId = (visual.bannerFileId ?? '').trim();
    if (globalFileId.length > 0) return globalFileId;
    const globalUrl = (visual.bannerUrl ?? '').trim();
    if (globalUrl.length > 0) return globalUrl;
  }
  return null;
}

// Cache resolved Telegram file_ids per banner reference so repeated
// navigation between banner screens doesn't re-download / re-upload.
const screenBannerFileIdCache = new Map<string, string>();

function truncateCaption(
  text: string,
  entities: readonly TgEntity[] | undefined,
): { caption: string; caption_entities: TgEntity[] | undefined } {
  if (text.length <= TELEGRAM_CAPTION_MAX) {
    return {
      caption: text,
      caption_entities: entities && entities.length > 0 ? [...entities] : undefined,
    };
  }
  const caption = text.slice(0, TELEGRAM_CAPTION_MAX - 3) + '...';
  const filtered = entities
    ? entities.filter((e) => e.offset + e.length <= TELEGRAM_CAPTION_MAX - 3)
    : undefined;
  return {
    caption,
    caption_entities: filtered && filtered.length > 0 ? [...filtered] : undefined,
  };
}

function rememberFileId(ref: string, sent: unknown): void {
  const photo = (sent as { photo?: Array<{ file_id?: string }> } | undefined)?.photo;
  const fileId =
    Array.isArray(photo) && photo.length > 0 ? photo[photo.length - 1]?.file_id : undefined;
  if (typeof fileId === 'string' && fileId.length > 0) {
    if (screenBannerFileIdCache.size > 32) screenBannerFileIdCache.clear();
    screenBannerFileIdCache.set(ref, fileId);
  }
}

/** Turn a banner reference into a Telegram-sendable source (file_id / URL / InputFile). */
async function resolveSource(
  ref: string,
  deps: ScreenBannerDeps,
): Promise<BannerPhotoSource | null> {
  const cached = screenBannerFileIdCache.get(ref);
  if (cached !== undefined) return cached;
  return resolveBannerSource(ref, {
    rezeisAdminUrl: deps.rezeisAdminUrl,
    logger: deps.logger,
  });
}

export interface RenderScreenOptions {
  readonly text: string;
  readonly entities?: readonly TgEntity[];
  readonly replyMarkup?: InlineKeyboard;
  readonly bannerRef: string | null;
}

function messageHasPhoto(ctx: Context): boolean {
  const msg = ctx.callbackQuery?.message;
  return (
    msg !== undefined &&
    'photo' in msg &&
    Array.isArray((msg as { photo?: unknown[] }).photo) &&
    (msg as { photo: unknown[] }).photo.length > 0
  );
}

/**
 * Render a screen with its banner. Returns `true` when this helper took
 * the render; `false` when the caller should fall back to its plain
 * `editOrReply` text path (no banner desired, or the banner couldn't be
 * resolved — e.g. admin host unreachable).
 */
export async function renderScreenWithBanner(
  ctx: Context,
  options: RenderScreenOptions,
  deps: ScreenBannerDeps,
): Promise<boolean> {
  const { text, entities, replyMarkup, bannerRef } = options;
  if (bannerRef === null) return false;

  const source = await resolveSource(bannerRef, deps);
  if (source === null) return false;

  const { caption, caption_entities } = truncateCaption(text, entities);

  if (messageHasPhoto(ctx)) {
    // Photo → photo: swap the media in place (no flicker).
    try {
      const media = InputMediaBuilder.photo(source, { caption, caption_entities });
      const edited = await ctx.editMessageMedia(media, { reply_markup: replyMarkup });
      if (typeof source !== 'string') rememberFileId(bannerRef, edited);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('message is not modified')) {
        deps.logger?.warn({ err, bannerRef }, 'screen-banner: editMessageMedia failed');
      }
    }
    return true;
  }

  // Text → photo: Telegram can't morph a text message, so delete + resend.
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  await ctx.deleteMessage().catch(() => undefined);
  try {
    const sent = await ctx.api.sendPhoto(chatId, source, {
      caption,
      caption_entities,
      reply_markup: replyMarkup,
    });
    if (typeof source !== 'string') rememberFileId(bannerRef, sent);
  } catch (err: unknown) {
    deps.logger?.warn({ err, bannerRef }, 'screen-banner: sendPhoto failed');
    // Never strand the user — fall back to a plain text message.
    await ctx.api
      .sendMessage(chatId, text, {
        entities: entities && entities.length > 0 ? [...entities] : undefined,
        reply_markup: replyMarkup,
      })
      .catch(() => undefined);
  }
  return true;
}
