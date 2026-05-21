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
 * Load translations from backend (rezeis-admin publicConfig.translations).
 * Flattens nested objects into dot-separated keys.
 */
export function setTranslations(translations: Record<string, Record<string, unknown>> | undefined | null): void {
  if (!translations) {
    _externalPacks = {};
    return;
  }
  const packs: Record<string, Record<string, string>> = {};
  for (const [lang, pack] of Object.entries(translations)) {
    if (lang === 'ru') continue; // RU is hardcoded
    const flat: Record<string, string> = {};
    flattenObj(pack, '', flat);
    packs[lang] = flat;
  }
  _externalPacks = packs;
}

function flattenObj(obj: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'object' && v !== null) flattenObj(v as Record<string, unknown>, key, out);
  }
}

/**
 * Translate a key with optional variable interpolation.
 * Lookup order: external pack → builtin pack → RU fallback → key itself.
 */
export function t(key: string, lang = 'ru', vars?: Record<string, string | number>): string {
  let val: string | undefined;

  if (lang !== 'ru') {
    // Try external translations first (from admin panel)
    const extPack = _externalPacks[lang];
    if (extPack) {
      val = extPack[`bot.${key}`] ?? extPack[key];
    }
    // Then try builtin pack
    if (!val) {
      const builtIn = BUILTIN_PACKS[lang];
      if (builtIn) val = builtIn[key];
    }
  }

  // Fallback to Russian
  if (!val) val = RU[key] ?? key;

  // Variable interpolation
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
