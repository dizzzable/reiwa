/**
 * Main reply keyboard builder.
 *
 * Composes a grammy `InlineKeyboard` from the operator-managed bot
 * config plus the resolved per-button URL/Mini-App routes. Pure logic,
 * no network or grammy lifecycle coupling — easy to unit-test.
 *
 * Three button kinds:
 *   - `url`      — opens an external HTTPS URL in Telegram's in-app
 *                  browser. Built from `publicWebUrl + binding.path`.
 *                  Drops the button silently when no safe URL exists
 *                  (dev where `publicWebUrl` is `null`).
 *   - `webapp`   — opens the Mini App. Telegram requires HTTPS; we
 *                  drop the button when `miniAppUrl` is `null`.
 *   - `callback` — emits `callback_data === buttonId`; routed by
 *                  reiwa's `bot.callbackQuery(id, ...)` handlers.
 *
 * The admin panel only manages visual properties (label, style,
 * visibility, ordering, single-row flag). The `kind` per well-known
 * `buttonId` is hardcoded in `BUTTON_KIND_MAP` so admin operators
 * can't accidentally turn "Мой кабинет" into a callback that
 * doesn't exist or vice-versa. Unknown ids default to `callback`.
 */
import { InlineKeyboard } from 'grammy';

import type { BotMenuButton } from '../../infrastructure/bot-config/types.js';
import type { TranslatorPort } from '../../application/ports/translator.port.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

export type ButtonKind = 'url' | 'webapp' | 'callback';

export interface ButtonBinding {
  readonly kind: ButtonKind;
  readonly path?: string;
}

/**
 * Telegram refuses inline-keyboard URLs that point at `localhost` /
 * `127.0.0.1` AND `web_app` URLs that aren't HTTPS. Both checks funnel
 * through this gate so dev (where `REIWA_DOMAIN=localhost:5173`
 * resolves to `http://localhost:5173`) doesn't crash the entire reply
 * with `400 Bad Request`. In production the operator types a real
 * domain and this becomes identical to `reiwaPublicUrl`.
 */
export function isTelegramSafeButtonUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  if (lower.includes('://localhost') || lower.includes('://127.0.0.1')) return false;
  return true;
}

export const BUTTON_KIND_MAP: Readonly<Record<string, ButtonBinding>> = {
  // Default reiwa keyboard
  cabinet: { kind: 'url', path: '/' },
  invite: { kind: 'callback' },
  rules: { kind: 'callback' },
  help: { kind: 'callback' },
  // Legacy buttons that older deployments may still have configured
  subscription: { kind: 'callback' },
  buy: { kind: 'callback' },
  promo: { kind: 'callback' },
  referrals: { kind: 'callback' },
  profile: { kind: 'callback' },
  activity: { kind: 'callback' },
  vpn: { kind: 'webapp', path: '/subscribe' },
  miniapp: { kind: 'webapp', path: '/' },
  support: { kind: 'callback' },
};

export function resolveBinding(buttonId: string): ButtonBinding {
  return BUTTON_KIND_MAP[buttonId] ?? { kind: 'callback' };
}

export interface MainKeyboardOptions {
  readonly buttons: readonly BotMenuButton[];
  readonly miniAppUrl: string | null | undefined;
  readonly publicWebUrl: string | null | undefined;
  readonly lang: SupportedLocale;
  readonly translator: TranslatorPort;
}

/**
 * STEALTHNET-style keyboard builder. Walks visible buttons in order,
 * places each on its own row when `onePerRow=true` or pairs them when
 * `onePerRow=false` (max 2 per row).
 */
export function buildMainKeyboard(options: MainKeyboardOptions): InlineKeyboard {
  const { buttons, miniAppUrl, publicWebUrl, lang, translator } = options;
  const visible = [...buttons]
    .filter((b) => b.visible)
    .sort((a, b) => a.order - b.order);

  const kb = new InlineKeyboard();
  let rowItems = 0;
  const closeRowIfNeeded = (force: boolean): void => {
    if (force && rowItems > 0) {
      kb.row();
      rowItems = 0;
    }
  };

  for (const btn of visible) {
    const localisedLabel = translator.resolveButtonLabel(btn.id, btn.label, lang);
    const label = btn.emoji ? `${btn.emoji} ${localisedLabel}` : localisedLabel;
    const binding = resolveBinding(btn.id);
    const path = binding.path ?? '';

    let placed = false;
    if (binding.kind === 'webapp') {
      if (!miniAppUrl) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.webApp(label, `${miniAppUrl}${path}`);
      placed = true;
    } else if (binding.kind === 'url') {
      if (!publicWebUrl) continue;
      closeRowIfNeeded(btn.onePerRow);
      kb.url(label, `${publicWebUrl}${path}`);
      placed = true;
    } else {
      closeRowIfNeeded(btn.onePerRow);
      kb.text(label, btn.id);
      placed = true;
    }

    if (!placed) continue;
    if (btn.onePerRow) {
      kb.row();
      rowItems = 0;
    } else {
      rowItems++;
      if (rowItems === 2) {
        kb.row();
        rowItems = 0;
      }
    }
  }

  if (rowItems > 0) kb.row();
  return kb;
}
