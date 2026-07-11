/**
 * Hard-coded Russian baseline pack.
 *
 * RU is the source-of-truth locale: every translation key is guaranteed
 * to resolve in Russian even with no admin-managed overrides loaded.
 * Other locales (see `en.pack.ts`) are derived translations and may be
 * sparse — `t()` falls back here when a key is missing in the requested
 * pack.
 */
export const RU_PACK: Readonly<Record<string, string>> = {
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
  'menu.btn_trial_free': 'Попробовать бесплатно',
  'menu.btn_trial_paid': 'Попробовать за {{price}}',

  // ── Pre-registration funnel ─────────────────────────────────────────────────
  'start.open_app': '📱 Открыть приложение',
  'start.need_register': 'Для использования сервиса откройте приложение и создайте аккаунт.',

  // ── Mini-profile (greeting summary) ─────────────────────────────────────────
  'profile.subscription': 'Подписка',
  'profile.devices': 'Устройств: {{count}} доступно',
  'profile.devices_unlimited': 'Устройств: безлимит',
  'profile.traffic': 'Трафик',
  'profile.until': 'До',
  'profile.unlimited': 'Безлимит',
  'common.not_available': 'Н/Д',

  // ── Platform access mode (kill-switch banners shown by /start) ──────────────
  'access_mode.restricted':
    '🛠 Сервис временно недоступен — ведутся технические работы. Существующие подключения VPN продолжают работать. Попробуйте позже.',
  'access_mode.reg_blocked_new':
    '🚫 Регистрация в сервисе временно отключена. Свяжитесь с поддержкой, если у вас уже есть аккаунт.',
  'access_mode.invited_no_code':
    '✉️ Сейчас регистрация только по приглашению. Откройте бота по invite-ссылке от друга или партнёра.',
  'access_mode.purchase_blocked':
    '🛒 Покупка временно недоступна. Действующие подписки можно продлевать как обычно.',

  // ── Telegram account linking (code submitted from web cabinet) ──────────────
  'link.success': '✅ Telegram успешно привязан к вашему аккаунту.',
  'link.invalid': '❌ Код привязки неверный или истёк. Получите новый код в кабинете.',
  'link.already_linked': '⚠️ Этот Telegram уже привязан к другому аккаунту. Войдите в него или обратитесь в поддержку.',
  'link.user_not_found': '❌ Аккаунт не найден. Получите новый код в кабинете.',
  'link.error': '❌ Не удалось привязать Telegram. Попробуйте позже.',

  // ── Возврат после оплаты (deep link t.me/<bot>?start=payment_return) ─────────
  'payment_return.title': '💳 Платёж обрабатывается. Вернитесь в приложение — статус обновится автоматически.',
  'payment_return.open_app': '📱 Открыть приложение',

  // ── Invite / Rules / Help ───────────────────────────────────────────────────
  'invite.share': '🔗 Реферальная программа\n\nПоделитесь ссылкой с друзьями — за каждого, кто оформит подписку, вы получите бонус.\n\nВаша ссылка:\n{{link}}',
  'invite.share_button': '📤 Поделиться в Telegram',
  'invite.copy_button': '📋 Скопировать ссылку',
  'invite.share_prompt': 'Привет! Попробуй Rezeis VPN — быстрый и надёжный.',
  'rules.intro': '📜 Правила сервиса\n\nНажмите кнопку ниже чтобы открыть полный текст:',
  'rules.open_button': '📜 Открыть правила',
  'rules.unavailable': '📜 Правила сервиса пока готовятся. Если у вас есть вопрос — напишите в поддержку.',
  'help.contact_support': 'Связаться с поддержкой: @{{username}}',
  'help.contact_button': '🆘 Написать в поддержку',
  'help.open_app_button': '🆘 Поддержка в приложении',
  'help.contact_prefill': 'Здравствуйте! Мне нужна помощь.',
  'error.unknown': '⚠️ Что-то пошло не так. Мы уже знаем о проблеме — попробуйте ещё раз чуть позже или напишите в поддержку.',

  // ── Slash-command bubble (Telegram setMyCommands) ───────────────────────────
  'commands.start.description': 'Главное меню',
  'commands.help.description': 'Справка и поддержка',
  'commands.lang.description': 'Сменить язык',
  'commands.rules.description': 'Правила сервиса',
  'commands.paysupport.description': 'Помощь с оплатой',

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

  // ── Referral / Partner hub (invite button) ───────────────────────────────────
  'referral.hub.title': '🔗 Реферальная программа',
  'referral.hub.description':
    'Приглашайте друзей по своей ссылке — за каждого, кто оформит подписку, вы получаете баллы. Баллы можно обменять в кабинете.',
  'referral.hub.stat_invited': '👥 Приглашено: {{count}}',
  'referral.hub.stat_qualified': '✅ Оформили подписку: {{count}}',
  'referral.hub.stat_pending': '⏳ В ожидании: {{count}}',
  'referral.hub.stat_points': '⭐ Баллов: {{count}}',
  'referral.hub.link_label': '🔗 Ваша реферальная ссылка:',
  'referral.hub.open_cabinet': '👤 Профиль в кабинете',
  'referral.hub.open_exchange': '💱 Обменять баллы',
  'partner.hub.title': '🤝 Партнёрская программа',
  'partner.hub.description':
    'Вы участник партнёрской программы. Получайте вознаграждение за приглашённых пользователей. Вывод средств — в кабинете.',
  'partner.hub.stat_balance': '💰 Баланс: {{amount}}',
  'partner.hub.stat_earned': '📈 Всего заработано: {{amount}}',
  'partner.hub.stat_referred': '👥 Рефералов: {{count}}',
  'partner.hub.open_cabinet': '🤝 Партнёрский кабинет',

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
  'lang.name.ru': 'Русский',
  'lang.name.en': 'английский',

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
  'support.not_configured': 'Раздел поддержки пока не настроен.',
  'support.title': '🆘 Поддержка\n\nНажмите кнопку ниже — мы ответим в личных сообщениях:',

  // ── Dynamic screens ─────────────────────────────────────────────────────────
  'screen.not_found': '⚠️ Этот экран был удалён или ещё не опубликован. Вернитесь в меню и попробуйте снова.',

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
  'channel.required': 'Для доступа к боту подпишитесь на наш канал, затем нажмите «Я подписался».',
  'channel.join_button': '📢 Перейти в канал',
  'channel.check_button': '✅ Я подписался',
  'channel.not_subscribed': '❌ Вы ещё не подписаны на канал. Подпишитесь и попробуйте снова.',
  'channel.verified': '✅ Подписка подтверждена!',
  // ── Channel-subscription quest (Phase B) ──────────────────────────────────────
  'quests.channel.verified': '✅ Подписка подтверждена! Забрать награду можно в кабинете.',
  'quests.channel.prompt': 'Подпишитесь на канал, затем нажмите «Я подписался», чтобы получить награду.',
  'quests.channel.not_subscribed': '❌ Вы ещё не подписаны на канал. Подпишитесь и нажмите кнопку снова.',
  'quests.channel.retry': '⚠️ Не удалось проверить подписку. Попробуйте ещё раз через пару секунд.',
  'quests.channel.link_first': '🔗 Сначала привяжите Telegram к аккаунту в кабинете, затем повторите.',
  // ── Bot-started operator notice ───────────────────────────────────────────────
  'bot_event.started': '☀️ Событие: Бот запущен!',
  'bot_event.access_mode': 'Режим доступа',
  'bot_event.mode.PUBLIC': '🟢 Разрешён для всех',
  'bot_event.mode.INVITED': '✉️ Только по приглашению',
  'bot_event.mode.PURCHASE_BLOCKED': '🛒 Покупки отключены',
  'bot_event.mode.REG_BLOCKED': '🚫 Регистрация отключена',
  'bot_event.mode.RESTRICTED': '🛠 Ограниченный режим',
  'bot_event.close': '❌ Закрыть',
  // ── Developer credits card ────────────────────────────────────────────────────
  'bot_event.credits.intro':
    'REIWA использует открытое ядро от dizzzable. Поскольку проект полностью БЕСПЛАТНЫЙ и с открытым исходным кодом, он существует только благодаря вашей поддержке.',
  'bot_event.credits.call_to_action':
    '⭐️ Поставьте звёздочку на <a href="https://github.com/dizzzable/reiwa">GitHub</a> и поддержите разработчика — он и так завис на полке для тупых 🤡',
  'bot_event.credits.wallets_title': '💸 Криптокошельки для поддержки:',
  'bot_event.credits.github': '⭐ GitHub',
  'bot_event.credits.telegram': '👥 Telegram',
  'bot_event.credits.support': '💰 Поддержать разработчика',
};
