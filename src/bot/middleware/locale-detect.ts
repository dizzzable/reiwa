/**
 * Locale auto-detect middleware.
 *
 * Telegram clients ship the *system* `language_code` of the device on
 * every update. We use it as the auto-detect signal:
 *   - First contact (cache miss): adopt the detected locale into the
 *     in-memory cache + push it to admin (fire-and-forget) so the
 *     next session across reiwa-bot / reiwa-api / web sees a
 *     consistent value.
 *   - Returning user with cached locale: trust the cache. The
 *     `/lang` command is the only override path — explicit user
 *     choice always wins over the device language.
 *
 * Extracted from bot/main.ts so it's unit-testable in isolation. The
 * factory takes the cache + detector + admin client as injectables;
 * production wiring closes over the singletons.
 */
import type { MiddlewareFn } from 'grammy';

import type { AdminClient } from '../../infrastructure/admin-client/index.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

import type { BotContext } from '../pages/types.js';

export interface UserLocaleSyncWriter {
  hasSync(userId: number): boolean;
  setSync(userId: number, lang: string): void;
}

export interface LocaleDetectDeps {
  readonly cache: UserLocaleSyncWriter;
  readonly detect: (raw: string | undefined | null) => SupportedLocale;
  readonly adminClient: AdminClient | null;
}

export function createLocaleDetectMiddleware(
  deps: LocaleDetectDeps,
): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const tgUser = ctx.from;
    if (tgUser !== undefined && !deps.cache.hasSync(tgUser.id)) {
      const detected = deps.detect(tgUser.language_code);
      deps.cache.setSync(tgUser.id, detected);
      // The local adopt above happens for every update type, because the
      // handler downstream has to render in SOMETHING. The push upstream does
      // not: an inline query can arrive from anyone who typed `@bot` in any
      // chat, including people with no account here, so this would be a write
      // to rezeis for a telegramId it has never seen, triggered by a
      // stranger’s keystroke. Nothing is lost for real users — `/start`
      // carries the language into `user.bootstrap` anyway.
      if (deps.adminClient !== null && ctx.inlineQuery === undefined) {
        deps.adminClient.user
          .updateLanguage({ telegramId: String(tgUser.id) }, detected.toUpperCase())
          .catch(() => {
            /* fire-and-forget — admin learns the locale on next bootstrap */
          });
      }
    }
    await next();
  };
}
