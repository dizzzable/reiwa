/**
 * Built-in English translation pack.
 *
 * Sparse keys fall back to `RU_PACK` (the source-of-truth baseline) at
 * lookup time. Operator overrides ingested via `LocalePackHydrator` win
 * over both built-in packs.
 */
export const EN_PACK: Readonly<Record<string, string>> = {
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

  // ── Mini-profile (greeting summary) ─────────────────────────────────────────
  'profile.subscription': 'Subscription',
  'profile.devices': 'Devices: {{count}} available',
  'profile.devices_unlimited': 'Devices: unlimited',
  'profile.traffic': 'Traffic',
  'profile.until': 'Until',
  'profile.unlimited': 'Unlimited',
  'common.not_available': 'N/A',

  // ── Platform access mode (kill-switch banners shown by /start) ──────────────
  'access_mode.restricted':
    '🛠 Service is temporarily unavailable — maintenance is in progress. Existing VPN connections keep working. Please try again later.',
  'access_mode.reg_blocked_new':
    '🚫 Registration is currently disabled. Contact support if you already have an account.',
  'access_mode.invited_no_code':
    '✉️ Registration is currently invite-only. Open the bot via an invite link from a friend or partner.',
  'access_mode.purchase_blocked':
    '🛒 New purchases are temporarily unavailable. Existing subscriptions can be renewed as usual.',

  // ── Telegram account linking (code submitted from web cabinet) ──────────────
  'link.success': '✅ Telegram has been linked to your account.',
  'link.invalid': '❌ The linking code is invalid or expired. Get a new code in the cabinet.',
  'link.already_linked': '⚠️ This Telegram is already linked to another account. Sign in to it or contact support.',
  'link.user_not_found': '❌ Account not found. Get a new code in the cabinet.',
  'link.error': '❌ Failed to link Telegram. Please try again later.',

  // ── Post-payment return (deep link t.me/<bot>?start=payment_return) ──────────
  'payment_return.title': '💳 Your payment is being processed. Return to the app — the status will update automatically.',
  'payment_return.open_app': '📱 Open app',

  // ── Invite / Rules / Help ───────────────────────────────────────────────────
  'invite.share': '🔗 Referral program\n\nShare this link with your friends — for every one who subscribes, you earn a bonus.\n\nYour link:\n{{link}}',
  'invite.share_button': '📤 Share on Telegram',
  'invite.copy_button': '📋 Copy link',
  'invite.share_prompt': 'Hey! Try Rezeis VPN — fast and reliable.',
  'rules.intro': '📜 Service rules\n\nTap the button below to open the full text:',
  'rules.open_button': '📜 Open rules',
  'rules.unavailable': '📜 Service rules are still being prepared. If you have a question — message support.',
  'help.contact_support': 'Contact support: @{{username}}',
  'help.contact_button': '🆘 Message support',
  'help.contact_prefill': 'Hi! I need help.',

  // ── Slash-command bubble (Telegram setMyCommands) ───────────────────────────
  'commands.start.description': 'Main menu',
  'commands.help.description': 'Help & support',
  'commands.lang.description': 'Change language',
  'commands.rules.description': 'Service rules',
  'commands.paysupport.description': 'Payment help',

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
  'lang.name.ru': 'Russian',
  'lang.name.en': 'English',

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
  'support.not_configured': 'Support is not configured yet.',
  'support.title': '🆘 Support\n\nTap the button below — we reply in DMs:',

  // ── Dynamic screens ─────────────────────────────────────────────────────────
  'screen.not_found': '⚠️ This screen was deleted or not yet published. Go back to the menu and try again.',

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
  'channel.required': 'To use the bot, subscribe to our channel, then tap "I subscribed".',
  'channel.join_button': '📢 Open channel',
  'channel.check_button': '✅ I subscribed',
  'channel.not_subscribed': '❌ You are not subscribed yet. Subscribe and try again.',
  'channel.verified': '✅ Subscription confirmed!',
};
