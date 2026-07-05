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
import { editOrReply } from './edit-message.js';
import type { PageDeps } from './types.js';

const TELEGRAM_CAPTION_MAX = 1024;

export interface ScreenBannerDeps {
  readonly rezeisAdminUrl: string | null;
  readonly logger?: { warn: (obj: unknown, msg: string) => void };
  /**
   * Persist a Telegram-resolved `file_id` for a screen's OWN photo banner into
   * the durable last-known-good snapshot, so after a reboot the first send
   * re-uses the `file_id` instead of re-fetching the bytes from rezeis (which
   * would fail while the admin host is down). No-op in tests / when omitted.
   */
  readonly rememberScreenBannerFileId?: (shortId: string, mediaUrl: string, fileId: string) => void;
}

/**
 * Resolve the raw banner reference a screen should display: its own photo
 * media first, then the global banner when "apply to all" is enabled, else
 * `null`. Only photo media counts as a banner — video / document / animation
 * keep the legacy text render.
 */
export function resolveScreenBannerRef(
  screen: BotScreen | null,
  visual: BotVisualConfig,
): string | null {
  if (screen !== null && screen.mediaType === 'photo') {
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

function rememberFileId(ref: string, sent: unknown): string | undefined {
  const photo = (sent as { photo?: Array<{ file_id?: string }> } | undefined)?.photo;
  const fileId =
    Array.isArray(photo) && photo.length > 0 ? photo[photo.length - 1]?.file_id : undefined;
  if (typeof fileId === 'string' && fileId.length > 0) {
    if (screenBannerFileIdCache.size > 32) screenBannerFileIdCache.clear();
    screenBannerFileIdCache.set(ref, fileId);
    return fileId;
  }
  return undefined;
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
  /**
   * The screen's shortId + its OWN photo `mediaUrl` (when the banner is the
   * screen's own media, not the global one). When both are set and the sent
   * banner resolved from this URL, the resulting Telegram `file_id` is stamped
   * into the durable snapshot so it survives a reboot.
   */
  readonly screenShortId?: string;
  readonly ownBannerUrl?: string | null;
  /**
   * When `'HTML'`, the caption is sent with `parse_mode: 'HTML'` (and no
   * `caption_entities` — Telegram forbids combining the two). Used by
   * screens whose operator-chosen `parseMode` is HTML. On a Telegram parse
   * error (e.g. a stray `<` in legacy copy) we transparently retry without
   * a parse mode so a delivery is never lost.
   */
  readonly parseMode?: 'HTML';
}

/** True for the Telegram "can't parse entities" 400 family. */
function isParseError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /can't parse|parse entities|unsupported start tag|unclosed|tag .* mismatch|byte offset/i.test(
    msg,
  );
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
  const { text, entities, replyMarkup, bannerRef, parseMode, screenShortId, ownBannerUrl } = options;
  if (bannerRef === null) return false;

  const source = await resolveSource(bannerRef, deps);
  if (source === null) return false;

  // Persist the resolved Telegram file_id for the screen's OWN banner so a
  // reboot re-uses it instead of re-fetching from rezeis (only when the banner
  // is the screen's own photo URL — never for the shared global banner).
  const stampDurable = (fileId: string | undefined): void => {
    if (
      fileId !== undefined &&
      screenShortId !== undefined &&
      typeof ownBannerUrl === 'string' &&
      ownBannerUrl.length > 0 &&
      bannerRef === ownBannerUrl
    ) {
      deps.rememberScreenBannerFileId?.(screenShortId, ownBannerUrl, fileId);
    }
  };

  const html = parseMode === 'HTML';
  // HTML captions are sent as-is (truncating could split a tag); the entity
  // path keeps its 1024-char clamp.
  const { caption, caption_entities } = html
    ? { caption: text, caption_entities: undefined }
    : truncateCaption(text, entities);

  if (messageHasPhoto(ctx)) {
    // Photo → photo: swap the media in place (no flicker).
    try {
      const media = html
        ? InputMediaBuilder.photo(source, { caption, parse_mode: 'HTML' })
        : InputMediaBuilder.photo(source, { caption, caption_entities });
      const edited = await ctx.editMessageMedia(media, { reply_markup: replyMarkup });
      if (typeof source !== 'string') stampDurable(rememberFileId(bannerRef, edited));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (html && isParseError(err)) {
        // Stray markup in a legacy HTML screen — retry the swap as a plain
        // caption so the banner still renders.
        try {
          const media = InputMediaBuilder.photo(source, { caption });
          const edited = await ctx.editMessageMedia(media, { reply_markup: replyMarkup });
          if (typeof source !== 'string') stampDurable(rememberFileId(bannerRef, edited));
        } catch (retryErr: unknown) {
          deps.logger?.warn({ err: retryErr, bannerRef }, 'screen-banner: editMessageMedia retry failed');
        }
      } else if (!msg.includes('message is not modified')) {
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
      parse_mode: html ? 'HTML' : undefined,
      caption_entities: html ? undefined : caption_entities,
      reply_markup: replyMarkup,
    });
    if (typeof source !== 'string') stampDurable(rememberFileId(bannerRef, sent));
  } catch (err: unknown) {
    if (html && isParseError(err)) {
      // Stray markup — resend the photo with a plain caption.
      try {
        const sent = await ctx.api.sendPhoto(chatId, source, { caption, reply_markup: replyMarkup });
        if (typeof source !== 'string') stampDurable(rememberFileId(bannerRef, sent));
        return true;
      } catch {
        /* fall through to the plain-text safety net below */
      }
    }
    deps.logger?.warn({ err, bannerRef }, 'screen-banner: sendPhoto failed');
    // Never strand the user — fall back to a plain text message.
    await ctx.api
      .sendMessage(chatId, text, {
        parse_mode: html ? 'HTML' : undefined,
        entities: !html && entities && entities.length > 0 ? [...entities] : undefined,
        reply_markup: replyMarkup,
      })
      .catch(() =>
        // Last resort: drop the parse mode entirely.
        html
          ? ctx.api.sendMessage(chatId, text, { reply_markup: replyMarkup }).catch(() => undefined)
          : undefined,
      );
  }
  return true;
}

/**
 * Render an operator-configured named screen (invite / rules / help) with its
 * per-screen banner, correctly transitioning from whatever banner the previous
 * message carried: a screen's own photo media (or the global banner when "one
 * banner for all screens" is on) is rendered as a real photo, and a screen with
 * no banner deletes+resends as text when the live message is a stale photo (so
 * another screen's banner never lingers), else keeps the flicker-free edit.
 *
 * `overrideScreen` is the operator's screen (from `findScreenByName`) or `null`
 * when the operator hasn't customised it — in which case only the global banner
 * can apply.
 */
export async function renderScreenOrEdit(
  ctx: Context,
  deps: Pick<PageDeps, 'urls' | 'logger' | 'rememberScreenBannerFileId'>,
  visual: BotVisualConfig,
  options: {
    readonly overrideScreen: BotScreen | null;
    readonly text: string;
    readonly entities?: readonly TgEntity[];
    readonly parseMode?: 'HTML';
    readonly replyMarkup?: InlineKeyboard;
  },
): Promise<void> {
  const { overrideScreen, text, entities, parseMode, replyMarkup } = options;
  const bannerRef = resolveScreenBannerRef(overrideScreen, visual);
  await renderViewWithBanner(
    ctx,
    {
      rezeisAdminUrl: deps.urls.rezeisAdminUrl,
      rememberScreenBannerFileId: deps.rememberScreenBannerFileId,
      logger: deps.logger
        ? {
            warn: (obj, msg): void => {
              deps.logger?.warn(obj as Record<string, unknown>, msg);
            },
          }
        : undefined,
    },
    {
      text,
      entities,
      parseMode,
      replyMarkup,
      bannerRef,
      screenShortId: overrideScreen?.shortId,
      ownBannerUrl: overrideScreen?.mediaType === 'photo' ? overrideScreen.mediaUrl : null,
    },
  );
}

/**
 * The global operator/welcome banner reference — ALWAYS the configured banner
 * (unlike `resolveScreenBannerRef`, this is NOT gated by `bannerApplyAll`,
 * because the welcome screen shows its banner unconditionally). Prefers the
 * cached Telegram `file_id` (instant) over the URL. `null` when none set.
 */
export function resolveWelcomeBannerRef(visual: BotVisualConfig): string | null {
  const fileId = (visual.bannerFileId ?? '').trim();
  if (fileId.length > 0) return fileId;
  const url = (visual.bannerUrl ?? '').trim();
  if (url.length > 0) return url;
  return null;
}

/**
 * Render a view (text + keyboard) while correctly transitioning the CURRENT
 * message's banner to the target one — the missing piece that let a sub-screen's
 * banner linger after navigating back:
 *
 *   • target has a banner → swap/send it (`renderScreenWithBanner`).
 *   • target has NO banner but the live message is a photo → it carries a stale
 *     banner from another screen; Telegram can't turn a photo into text via an
 *     edit, so delete + resend as text.
 *   • otherwise → plain in-place text/caption edit.
 *
 * Used by every screen transition (menu:main back-navigation, named
 * override screens via `renderScreenOrEdit`, and the dynamic `screen:*`
 * handler) so the message always shows the TARGET screen's banner — its
 * own photo media, the global banner when "one banner for all screens" is
 * on, or none — never whichever screen the user came from.
 */
export async function renderViewWithBanner(
  ctx: Context,
  deps: ScreenBannerDeps,
  options: {
    readonly text: string;
    readonly entities?: readonly TgEntity[];
    readonly parseMode?: 'HTML';
    readonly replyMarkup?: InlineKeyboard;
    readonly bannerRef: string | null;
    /** Screen shortId — enables durable file_id stamping of its own banner. */
    readonly screenShortId?: string;
    /** The screen's OWN photo mediaUrl (for durable file_id stamping). */
    readonly ownBannerUrl?: string | null;
  },
): Promise<void> {
  if (options.bannerRef !== null) {
    const handled = await renderScreenWithBanner(
      ctx,
      {
        text: options.text,
        entities: options.entities,
        parseMode: options.parseMode,
        replyMarkup: options.replyMarkup,
        bannerRef: options.bannerRef,
        screenShortId: options.screenShortId,
        ownBannerUrl: options.ownBannerUrl,
      },
      deps,
    );
    if (handled) return;
    // Banner failed to resolve — fall through to the text paths below.
  }

  if (messageHasPhoto(ctx)) {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      await ctx.deleteMessage().catch(() => undefined);
      const html = options.parseMode === 'HTML';
      await ctx.api
        .sendMessage(chatId, options.text, {
          parse_mode: html ? 'HTML' : undefined,
          entities:
            !html && options.entities && options.entities.length > 0
              ? [...options.entities]
              : undefined,
          reply_markup: options.replyMarkup,
        })
        .catch(() =>
          // Stray markup / entity issue — never strand the user: resend the
          // text with no parse mode so a delivery still lands.
          ctx.api
            .sendMessage(chatId, options.text, { reply_markup: options.replyMarkup })
            .catch(() => undefined),
        );
      return;
    }
  }

  await editOrReply(ctx, {
    text: options.text,
    entities: options.entities,
    parseMode: options.parseMode,
    replyMarkup: options.replyMarkup,
  });
}
