/**
 * Reiwa bot i18n module.
 * Russian defaults are hardcoded. Other languages loaded from rezeis-admin
 * via publicConfig.translations and stored in memory.
 *
 * Pattern adopted from STEALTHNET 4.0.0 i18n module.
 */

export const RU: Record<string, string> = {
  // ── General ─────────────────────────────────────────────────────────────────
  back_to_menu: '◀️ В меню',
  back: '◀️ Назад',
  cancel: 'Отмена',
  error_generic: 'Ошибка',
  unknown_error: 'Неизвестная ошибка',

  // ── Menu ────────────────────────────────────────────────────────────────────
  'menu.choose_action': 'Выберите действие:',
  'menu.btn_subscription': '📦 Мои подписки',
  'menu.btn_buy': '💳 Купить подписку',
  'menu.btn_promo': '🎁 Промокод',
  'menu.btn_referrals': '👥 Рефералы',
  'menu.btn_activity': '📊 Активность',
  'menu.btn_profile': '👤 Профиль',
  'menu.btn_devices': '📱 Устройства',
  'menu.btn_vpn': '🌐 Подключиться к VPN',
  'menu.btn_support': '🆘 Поддержка',
  'menu.btn_miniapp': '📱 Открыть приложение',
  'menu.btn_lang': '🌐 Язык',

  // ── Pre-registration funnel ─────────────────────────────────────────────────
  'start.open_app': '📱 Открыть приложение',
  'start.need_register': 'Для использования сервиса откройте приложение и создайте аккаунт.',

  // ── Invite / Rules / Help ───────────────────────────────────────────────────
  'invite.share': 'Поделитесь ссылкой с друзьями:\n{{link}}',
  'rules.intro': 'Ознакомьтесь с правилами сервиса:',
  'rules.open_button': '📜 Открыть правила',
  'rules.unavailable': 'Правила пока не настроены оператором.',
  'help.contact_support': 'Связаться с поддержкой: @{{username}}',

  // ── Commands ────────────────────────────────────────────────────────────────
  'help.title': '🔍 Доступные команды:\n',
  'help.start': '/start — Главное меню',
  'help.subscription': '/subscription — Текущая подписка',
  'help.plans': '/plans — Доступные тарифы',
  'help.promo': '/promo — Активировать промокод',
  'help.referral': '/referral — Реферальная ссылка',
  'help.profile': '/profile — Профиль',
  'help.lang': '/lang — Сменить язык',
  'help.help': '/help — Эта справка',

  // ── Subscription ────────────────────────────────────────────────────────────
  'subscription.no_active': '📦 У вас нет активной подписки.\n\nИспользуйте /plans для просмотра тарифов.',
  'subscription.error': 'Не удалось получить данные подписки. Попробуйте позже.',
  'subscription.header': 'Подписка',
  'subscription.status': 'Статус: {{status}}',
  'subscription.plan': '📋 Тариф: {{name}}',
  'subscription.trial': 'Пробный период',
  'subscription.expires': '📅 Истекает: {{date}}',
  'subscription.traffic': 'Трафик: {{value}}',
  'subscription.devices': 'Устройства: {{value}}',
  'subscription.traffic_unlimited': 'Безлимит',
  'subscription.devices_unlimited': 'Безлимит',

  // ── Plans ───────────────────────────────────────────────────────────────────
  'plans.header': 'Доступные тарифы',
  'plans.empty': 'Нет доступных тарифов.',
  'plans.error': 'Не удалось загрузить тарифы. Попробуйте позже.',
  'plans.traffic': 'Трафик: {{value}}',
  'plans.devices': 'Устройств: {{value}}',
  'plans.duration_price': '{{days}} дн. — {{price}} {{currency}}',
  'plans.open_app': 'Выберите тариф в приложении:',
  'plans.open_app_button': '📱 Открыть тарифы',
  'plans.use_command': 'Используйте /plans для просмотра тарифов.',

  // ── Promo ───────────────────────────────────────────────────────────────────
  'promo.disabled': 'Промокоды временно недоступны.',
  'promo.enter': '🎁 Введите промокод:',
  'promo.activated': '✅ Промокод активирован!',
  'promo.failed': '❌ Не удалось активировать промокод «{{code}}».',
  'promo.error': '❌ Ошибка: {{message}}',

  // ── Referral ────────────────────────────────────────────────────────────────
  'referral.disabled': 'Реферальная программа недоступна.',
  'referral.header': 'Реферальная программа',
  'referral.invited': 'Приглашено: {{count}}',
  'referral.qualified': 'Квалифицировано: {{count}}',
  'referral.link_label': '🔗 Ваша реферальная ссылка:',
  'referral.link_unavailable': 'Ссылка временно недоступна',
  'referral.error': 'Не удалось загрузить реферальные данные.',

  // ── Profile ─────────────────────────────────────────────────────────────────
  'profile.header': 'Профиль',
  'profile.name': '👤 Имя: {{name}}',
  'profile.username': '📎 Username: @{{username}}',
  'profile.language': '🌐 Язык: {{lang}}',
  'profile.points': '⭐ Баллы: {{points}}',
  'profile.discount': '💰 Скидка: {{discount}}%',
  'profile.referral_code': '🔗 Реферальный код: {{code}}',
  'profile.has_subscription': '📦 Подписка: активна',
  'profile.no_subscription': '📦 Подписка: нет',

  // ── Language ────────────────────────────────────────────────────────────────
  'lang.choose': '🌐 Выберите язык:',
  'lang.changed': '✅ Язык изменён на {{lang}}',
  'lang.ru': '🇷🇺 Русский',
  'lang.en': '🇬🇧 English',

  // ── Activity ────────────────────────────────────────────────────────────────
  'activity.header': '📊 Последние транзакции:',
  'activity.empty': '📊 Транзакций пока нет.',
  'activity.error': 'Ошибка загрузки активности.',

  // ── Devices ─────────────────────────────────────────────────────────────────
  'devices.header': '📱 Устройства',
  'devices.empty': '📱 Устройства\n\nПривязанных устройств пока нет. Подключитесь к VPN — устройство появится здесь.',
  'devices.error': 'Не удалось загрузить устройства.',

  // ── VPN ─────────────────────────────────────────────────────────────────────
  'vpn.no_subscription': 'Ссылка на VPN недоступна. Оформите подписку.',
  'vpn.connect_title': 'Подключиться к VPN',
  'vpn.connect_hint': 'Нажмите кнопку ниже — откроется страница подключения.',
  'vpn.btn_open_page': '📲 Открыть страницу подключения',

  // ── Support ─────────────────────────────────────────────────────────────────
  'support.not_configured': 'Раздел поддержки не настроен.',
  'support.title': '🆘 Поддержка',

  // ── Days pluralization ──────────────────────────────────────────────────────
  'day.one': 'день',
  'day.few': 'дня',
  'day.many': 'дней',

  // ── Channel subscription ────────────────────────────────────────────────────
  'subscribe.channel_button': '📢 Подписаться на канал',
  'subscribe.check_button': '✅ Я подписался',
  'subscribe.default_message': 'Для использования бота подпишитесь на наш канал:',
  'subscribe.not_subscribed': '❌ Вы ещё не подписались на канал',
  'subscribe.confirmed': '✅ Подписка подтверждена!',
};

const EN: Record<string, string> = {
  // ── General ─────────────────────────────────────────────────────────────────
  back_to_menu: '◀️ Back to menu',
  back: '◀️ Back',
  cancel: 'Cancel',
  error_generic: 'Error',
  unknown_error: 'Unknown error',

  // ── Menu ────────────────────────────────────────────────────────────────────
  'menu.choose_action': 'Choose an action:',
  'menu.btn_subscription': '📦 My subscriptions',
  'menu.btn_buy': '💳 Buy subscription',
  'menu.btn_promo': '🎁 Promo code',
  'menu.btn_referrals': '👥 Referrals',
  'menu.btn_activity': '📊 Activity',
  'menu.btn_profile': '👤 Profile',
  'menu.btn_devices': '📱 Devices',
  'menu.btn_vpn': '🌐 Connect to VPN',
  'menu.btn_support': '🆘 Support',
  'menu.btn_miniapp': '📱 Open app',
  'menu.btn_lang': '🌐 Language',

  // ── Pre-registration funnel ─────────────────────────────────────────────────
  'start.open_app': '📱 Open app',
  'start.need_register': 'To use the service, open the app and create an account.',

  // ── Invite / Rules / Help ───────────────────────────────────────────────────
  'invite.share': 'Share this link with your friends:\n{{link}}',
  'rules.intro': 'Service rules:',
  'rules.open_button': '📜 Open rules',
  'rules.unavailable': 'Rules have not been configured by the operator yet.',
  'help.contact_support': 'Contact support: @{{username}}',

  // ── Commands ────────────────────────────────────────────────────────────────
  'help.title': '🔍 Available commands:\n',
  'help.start': '/start — Main menu',
  'help.subscription': '/subscription — Current subscription',
  'help.plans': '/plans — Available plans',
  'help.promo': '/promo — Activate promo code',
  'help.referral': '/referral — Referral link',
  'help.profile': '/profile — Profile',
  'help.lang': '/lang — Change language',
  'help.help': '/help — This help',

  // ── Subscription ────────────────────────────────────────────────────────────
  'subscription.no_active': '📦 You have no active subscription.\n\nUse /plans to view available plans.',
  'subscription.error': 'Failed to get subscription data. Try again later.',
  'subscription.header': 'Subscription',
  'subscription.status': 'Status: {{status}}',
  'subscription.plan': '📋 Plan: {{name}}',
  'subscription.trial': 'Trial period',
  'subscription.expires': '📅 Expires: {{date}}',
  'subscription.traffic': 'Traffic: {{value}}',
  'subscription.devices': 'Devices: {{value}}',
  'subscription.traffic_unlimited': 'Unlimited',
  'subscription.devices_unlimited': 'Unlimited',

  // ── Plans ───────────────────────────────────────────────────────────────────
  'plans.header': 'Available plans',
  'plans.empty': 'No plans available.',
  'plans.error': 'Failed to load plans. Try again later.',
  'plans.traffic': 'Traffic: {{value}}',
  'plans.devices': 'Devices: {{value}}',
  'plans.duration_price': '{{days}} days — {{price}} {{currency}}',
  'plans.open_app': 'Choose a plan in the app:',
  'plans.open_app_button': '📱 Open plans',
  'plans.use_command': 'Use /plans to view plans.',

  // ── Promo ───────────────────────────────────────────────────────────────────
  'promo.disabled': 'Promo codes are temporarily unavailable.',
  'promo.enter': '🎁 Enter promo code:',
  'promo.activated': '✅ Promo code activated!',
  'promo.failed': '❌ Failed to activate promo code "{{code}}".',
  'promo.error': '❌ Error: {{message}}',

  // ── Referral ────────────────────────────────────────────────────────────────
  'referral.disabled': 'Referral program is unavailable.',
  'referral.header': 'Referral Program',
  'referral.invited': 'Invited: {{count}}',
  'referral.qualified': 'Qualified: {{count}}',
  'referral.link_label': '🔗 Your referral link:',
  'referral.link_unavailable': 'Link temporarily unavailable',
  'referral.error': 'Failed to load referral data.',

  // ── Profile ─────────────────────────────────────────────────────────────────
  'profile.header': 'Profile',
  'profile.name': '👤 Name: {{name}}',
  'profile.username': '📎 Username: @{{username}}',
  'profile.language': '🌐 Language: {{lang}}',
  'profile.points': '⭐ Points: {{points}}',
  'profile.discount': '💰 Discount: {{discount}}%',
  'profile.referral_code': '🔗 Referral code: {{code}}',
  'profile.has_subscription': '📦 Subscription: active',
  'profile.no_subscription': '📦 Subscription: none',

  // ── Language ────────────────────────────────────────────────────────────────
  'lang.choose': '🌐 Choose language:',
  'lang.changed': '✅ Language changed to {{lang}}',
  'lang.ru': '🇷🇺 Russian',
  'lang.en': '🇬🇧 English',

  // ── Activity ────────────────────────────────────────────────────────────────
  'activity.header': '📊 Recent transactions:',
  'activity.empty': '📊 No transactions yet.',
  'activity.error': 'Failed to load activity.',

  // ── Devices ─────────────────────────────────────────────────────────────────
  'devices.header': '📱 Devices',
  'devices.empty': '📱 Devices\n\nNo linked devices yet. Connect to VPN — the device will appear here.',
  'devices.error': 'Failed to load devices.',

  // ── VPN ─────────────────────────────────────────────────────────────────────
  'vpn.no_subscription': 'VPN link is unavailable. Get a subscription.',
  'vpn.connect_title': 'Connect to VPN',
  'vpn.connect_hint': 'Click the button below — the connection page will open.',
  'vpn.btn_open_page': '📲 Open connection page',

  // ── Support ─────────────────────────────────────────────────────────────────
  'support.not_configured': 'Support section is not configured.',
  'support.title': '🆘 Support',

  // ── Days pluralization ──────────────────────────────────────────────────────
  'day.one': 'day',
  'day.few': 'days',
  'day.many': 'days',

  // ── Channel subscription ────────────────────────────────────────────────────
  'subscribe.channel_button': '📢 Subscribe to channel',
  'subscribe.check_button': '✅ I subscribed',
  'subscribe.default_message': 'To use the bot, subscribe to our channel:',
  'subscribe.not_subscribed': '❌ You haven\'t subscribed to the channel yet',
  'subscribe.confirmed': '✅ Subscription confirmed!',
};

const BUILTIN_PACKS: Record<string, Record<string, string>> = { en: EN };
let _externalPacks: Record<string, Record<string, string>> = {};

/**
 * Hydrate the in-memory translation packs from rezeis-admin's
 * `/api/internal/bot-config` response.
 *
 * Two input shapes are accepted (operators can mix both inside the same
 * `BotText` table):
 *   1. **Per-locale namespaced keys** — `key = '<lang>.<i18n key>'`
 *      e.g. `en.menu.choose_action`. Stripped of the `<lang>.` prefix
 *      and indexed under that locale's pack. Default for new deploys.
 *   2. **Per-key suffix** — `key = '<i18n key>.<lang>'` (legacy STEALTHNET
 *      layout) e.g. `menu.choose_action.en`. Same outcome, different
 *      visual grouping in the admin UI.
 *
 * Anything not matching the above is treated as a Russian baseline
 * override — operators editing copy in the admin without touching code.
 *
 * `button.<id>.<lang>` survives unchanged so `resolveButtonLabel` can
 * find it directly. RU is hard-coded — we still index ru-prefixed keys
 * so admin overrides still work (e.g. `ru.menu.choose_action`).
 */
export function setTranslations(translations: Record<string, unknown> | undefined | null): void {
  if (!translations) {
    _externalPacks = {};
    return;
  }
  const packs: Record<string, Record<string, string>> = {};
  const ensure = (lang: string): Record<string, string> => {
    let pack = packs[lang];
    if (!pack) {
      pack = {};
      packs[lang] = pack;
    }
    return pack;
  };

  for (const [rawKey, rawValue] of Object.entries(translations)) {
    if (typeof rawValue !== 'string') continue;
    // Shape (1): "<lang>.<i18n key>"
    const head = rawKey.split('.', 1)[0];
    if (head.length === 2 && /^[a-z]{2}$/.test(head)) {
      const subKey = rawKey.slice(head.length + 1);
      ensure(head)[subKey] = rawValue;
      // Also index `button.<id>.<lang>` directly to support resolveButtonLabel
      // when admin uses the per-locale-namespace shape.
      if (subKey.startsWith('button.')) {
        ensure(head)[rawKey] = rawValue;
      }
      continue;
    }
    // Shape (2): "<i18n key>.<lang>" — only the trailing 2-letter chunk
    // is treated as the locale tag.
    const lastDot = rawKey.lastIndexOf('.');
    if (lastDot > 0) {
      const tail = rawKey.slice(lastDot + 1);
      if (tail.length === 2 && /^[a-z]{2}$/.test(tail)) {
        const subKey = rawKey.slice(0, lastDot);
        ensure(tail)[subKey] = rawValue;
        // Mirror to `button.<id>.<lang>` so `resolveButtonLabel` finds it
        // regardless of which shape the admin used.
        if (subKey.startsWith('button.')) {
          ensure(tail)[`${subKey}.${tail}`] = rawValue;
        }
        continue;
      }
    }
    // Otherwise treat as a global RU override.
    ensure('ru')[rawKey] = rawValue;
  }
  _externalPacks = packs;
}

/**
 * Translate a key with optional variable interpolation.
 *
 * Lookup order:
 *   1. External pack for the requested locale (admin overrides). Tries
 *      both bare key (`menu.choose_action`) and the `bot.`-prefixed
 *      legacy form for back-compat.
 *   2. Builtin pack for the requested locale (e.g. `EN`).
 *   3. External RU pack (admin override of the hard-coded baseline).
 *   4. Hard-coded RU baseline.
 *   5. The raw key itself, so missing translations are visible at runtime.
 */
export function t(key: string, lang = 'ru', vars?: Record<string, string | number>): string {
  const lower = lang.toLowerCase();
  let val: string | undefined;

  if (lower !== 'ru') {
    const extPack = _externalPacks[lower];
    if (extPack) {
      val = extPack[key] ?? extPack[`bot.${key}`];
    }
    if (!val) {
      const builtIn = BUILTIN_PACKS[lower];
      if (builtIn) val = builtIn[key];
    }
  }

  if (!val) {
    const ruExt = _externalPacks['ru'];
    if (ruExt) val = ruExt[key] ?? ruExt[`bot.${key}`];
  }
  if (!val) val = RU[key] ?? key;

  if (vars) {
    for (const [vk, vv] of Object.entries(vars)) {
      val = val.split(`{{${vk}}}`).join(String(vv));
    }
  }

  return val;
}

/**
 * Format days with Russian pluralization.
 */
export function formatDays(n: number, lang = 'ru'): string {
  if (lang !== 'ru') return `${n} ${n === 1 ? t('day.one', lang) : t('day.many', lang)}`;
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  const last = abs % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${n} ${t('day.many', lang)}`;
  if (last === 1) return `${n} ${t('day.one', lang)}`;
  if (last >= 2 && last <= 4) return `${n} ${t('day.few', lang)}`;
  return `${n} ${t('day.many', lang)}`;
}

// ── Per-user language cache ───────────────────────────────────────────────────

const userLangCache = new Map<number, string>();

export function setUserLang(userId: number, lang: string): void {
  userLangCache.set(userId, lang.toLowerCase());
}

export function getUserLang(userId: number): string {
  return userLangCache.get(userId) ?? 'ru';
}

/**
 * Returns whether we have an explicit per-user locale override stored
 * for this Telegram user. Used by the auto-detect middleware to decide
 * if it should adopt the device language or trust an existing choice.
 */
export function userLangCacheHas(userId: number): boolean {
  return userLangCache.has(userId);
}

/**
 * List of locales the bot has translations for. Anything outside this
 * set falls back to `ru` — the hard-coded baseline.
 */
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['ru', 'en']);

/**
 * Maps a Telegram-supplied `language_code` (BCP-47-ish: `en`, `en-GB`,
 * `ru`, `pt-BR`, ...) onto the closest supported locale.
 *
 * Telegram clients deliver the *system* language of the device, so this
 * is the authoritative auto-detect signal: if a user's phone is set to
 * English, Telegram sends `en` and we render English on the very first
 * message, no `/lang` round-trip required.
 */
export function detectLocaleFromTelegram(rawLanguageCode: string | undefined | null): string {
  if (!rawLanguageCode) return 'ru';
  const lower = rawLanguageCode.toLowerCase();
  // Strip region tag (`en-GB` → `en`) and re-check against the supported set.
  const head = lower.split(/[-_]/, 1)[0];
  if (SUPPORTED_LOCALES.has(head)) return head;
  // Russian-script clones (`be`, `uk`) get Russian — the hard-coded
  // baseline is closer to them than English. Easy to extend later if a
  // dedicated pack ships.
  if (head === 'be' || head === 'uk' || head === 'kk') return 'ru';
  return 'ru';
}

/**
 * Resolve a localised label for a `BotButton`.
 *
 * Lookup order:
 *   1. `button.<id>.<lang>` in the operator-managed translation map
 *      — lets admin localise specific buttons without touching code.
 *   2. The raw `BotButton.label` from Prisma (admin's primary editor).
 *      This is the fallback when the operator did not translate the
 *      label for the requested locale.
 *
 * `translations` is the same map returned by `/api/internal/bot-config`
 * (the `translations` field). We accept it as a parameter so callers
 * can pass the live cached config without coupling i18n to the bot's
 * config layer.
 */
export function resolveButtonLabel(
  buttonId: string,
  fallbackLabel: string,
  translations: Readonly<Record<string, string>>,
  lang: string,
): string {
  const lower = lang.toLowerCase();
  const fullKey = `button.${buttonId}.${lower}`;
  // 1. Live `translations` map passed by the caller — this is the
  //    `bot-config.translations` object straight from admin.
  const direct = translations[fullKey];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct;
  // 2. The external pack hydrated by `setTranslations` — indexed by
  //    `button.<id>.<lang>` after locale-prefix stripping.
  const pack = _externalPacks[lower];
  if (pack !== undefined) {
    const fromPack = pack[fullKey] ?? pack[`button.${buttonId}`];
    if (typeof fromPack === 'string' && fromPack.trim().length > 0) return fromPack;
  }
  return fallbackLabel;
}
