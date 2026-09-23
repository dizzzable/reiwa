/**
 * `invite` hub specs.
 *
 * Renders STEALTHNET-style in place via `editOrReply`, so assertions target
 * `ctx.editMessageText`. The hub branches on partner status, shows a quick
 * summary, and deep-links to the cabinet for money-path actions (no in-bot
 * exchange / withdrawal).
 */
import { describe, expect, it, vi } from 'vitest';

import { registerInvitePage } from '../../../src/bot/pages/invite.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import {
  FIRE_ENTITY,
  OPERATOR_TEXT_GLYPHS,
  buildDeps,
  buildFakeBot,
  buildFakeCtx,
  operatorEmojiConfig,
  withOperatorText,
} from './helpers.js';

type Btn = { text?: string; url?: string; web_app?: { url: string }; copy_text?: { text: string } };

function register(bot: ReturnType<typeof buildFakeBot>, deps: PageDeps): void {
  registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
}

function buttonsOf(ctx: ReturnType<typeof buildFakeCtx>): Btn[] {
  const opts = ctx.editMessageText.mock.calls[0]?.[1] as
    | { reply_markup?: { inline_keyboard?: Btn[][] } }
    | undefined;
  return (opts?.reply_markup?.inline_keyboard ?? []).flat();
}

describe('registerInvitePage (hub)', () => {
  it('registers a single callback handler for the "invite" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    register(bot, deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('invite');
  });

  it('renders referral.disabled when the feature is off and the user is not a partner', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      },
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:referral.disabled', expect.anything());
  });

  it('renders the referral hub with link, summary, and cabinet deep-links', async () => {
    const createInvite = vi.fn();
    const getSummary = vi.fn().mockResolvedValue({
      totalReferrals: 3,
      qualifiedReferrals: 1,
      pointsBalance: 50,
      referralCode: 'reiwa-id-1',
    });
    const exchange = vi.fn();
    const adminClient = {
      referrals: { createInvite, getSummary, exchange },
      partner: {},
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 5 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).toContain('ru:referral.hub.title');
    expect(text).toContain('https://t.me/reiwa_test_bot?start=ref_reiwa-id-1');
    expect(text).toContain('ru:referral.hub.stat_invited(count=3)');
    expect(text).toContain('ru:referral.hub.stat_qualified(count=1)');
    expect(text).toContain('ru:referral.hub.stat_pending(count=2)');
    expect(text).toContain('ru:referral.hub.stat_points(count=50)');

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals')).toBe(true);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals/exchange')).toBe(true);
    // Read-only money path — the hub never performs an exchange.
    expect(exchange).not.toHaveBeenCalled();
    // The share link is the user's PERMANENT referral code, so opening the hub
    // must not mint a single-use invite (which would rotate the link, consume a
    // slot, and stop working after the first friend used it).
    expect(createInvite).not.toHaveBeenCalled();
    expect(getSummary).toHaveBeenCalledWith({ telegramId: '5' });
  });

  it('omits cabinet deep-links when no public web URL is configured', async () => {
    const createInvite = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const adminClient = { referrals: { createInvite } } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: null,
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app !== undefined)).toBe(false);
  });

  it('explains the invited-only restriction instead of "link unavailable"', async () => {
    // A permanent restriction used to surface as a temporary-sounding glitch.
    const getSummary = vi
      .fn()
      .mockResolvedValue({ referralCode: 'reiwa-id-1', programAvailable: false });
    const adminClient = { referrals: { getSummary } } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'ru:referral.invited_only',
      expect.anything(),
    );
  });

  it('never falls back to the raw telegramId when the summary lookup fails', async () => {
    // A share link is pasted into chats and channels and stays there forever,
    // so leaking the user's Telegram ID because the admin API blipped is not an
    // acceptable degradation — show "unavailable" instead.
    const getSummary = vi.fn().mockRejectedValue(new Error('admin down'));
    const adminClient = { referrals: { getSummary } } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).not.toContain('ref_42');
    expect(text).toBe('ru:referral.link_unavailable');
  });

  it('mints a single-use token under invite-only admission', async () => {
    // The permanent code does not open the INVITED gate, so sharing it would
    // hand the friend a link that is rejected at registration.
    const createInvite = vi.fn().mockResolvedValue({ invite: { token: 'tok-9' } });
    const getSummary = vi.fn().mockResolvedValue({
      referralCode: 'reiwa-id-1',
      admissionRequiresInvite: true,
    });
    const adminClient = {
      referrals: { createInvite, getSummary },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(createInvite).toHaveBeenCalledWith({ telegramId: '42' });
    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).toContain('https://t.me/reiwa_test_bot?start=ref_tok-9');
    expect(text).not.toContain('reiwa-id-1');
  });

  it('falls back to referral.link_unavailable with no bot username and no public URL', async () => {
    const getSummary = vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' });
    const adminClient = { referrals: { getSummary } } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: null,
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ me: { username: '' } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'ru:referral.link_unavailable',
      expect.anything(),
    );
  });

  it('renders the partner hub for an active partner', async () => {
    const createInvite = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const getStatus = vi.fn().mockResolvedValue({ isActive: true });
    const getInfo = vi.fn().mockResolvedValue({ balance: 100, totalEarned: 300 });
    const getReferrals = vi.fn().mockResolvedValue({ total: 7 });
    const withdraw = vi.fn();
    const adminClient = {
      referrals: { createInvite },
      partner: { getStatus, getInfo, getReferrals, withdraw },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 9 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).toContain('ru:partner.hub.title');
    expect(text).toContain('ru:partner.hub.stat_balance(amount=100)');
    expect(text).toContain('ru:partner.hub.stat_earned(amount=300)');
    expect(text).toContain('ru:partner.hub.stat_referred(count=7)');

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/partner')).toBe(true);
    // Read-only money path — the hub never performs a withdrawal.
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('renders the partner hub even when the referral feature is disabled', async () => {
    const getStatus = vi.fn().mockResolvedValue({ isActive: true });
    const getInfo = vi.fn().mockResolvedValue({ balance: 0, totalEarned: 0 });
    const getReferrals = vi.fn().mockResolvedValue({ total: 0 });
    const createInvite = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const adminClient = {
      referrals: { createInvite },
      partner: { getStatus, getInfo, getReferrals },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      },
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 9 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).toContain('ru:partner.hub.title');
  });

  /**
   * Referral points a partner earned BEFORE the appointment.
   *
   * The panel stops creating referral rewards once someone is a partner, so
   * the counter can never move again — but the points already earned are
   * still spendable, and this hub REPLACED the referral hub, which was the
   * only place in the bot that showed them or offered the exchange. Hence:
   * one line and one button, and only while there is something left to spend.
   *
   * The absence cases below assert the rest of the hub is still on screen.
   * A bare `not.toContain` passes just as happily when nothing rendered at
   * all, which would hide the very defect this feature is about.
   */
  it('shows the points a partner still owns, and the way to spend them', async () => {
    const getStatus = vi.fn().mockResolvedValue({ isActive: true });
    const getInfo = vi
      .fn()
      .mockResolvedValue({ balance: 100, totalEarned: 300, referralPoints: 40 });
    const getReferrals = vi.fn().mockResolvedValue({ total: 7 });
    const adminClient = {
      referrals: {},
      partner: { getStatus, getInfo, getReferrals },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 9 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    // The referral hub's own wording, not a partner-flavoured copy of it.
    expect(text).toContain('ru:referral.hub.stat_points(count=40)');
    // Two pots, two units. 40 points is a dimensionless integer; the balance
    // is minor units of currency. Nothing divides the points by 100 and
    // nothing routes them through the money line.
    expect(text).toContain('ru:partner.hub.stat_balance(amount=100)');
    expect(text).not.toContain('stat_points(count=0.4)');
    expect(text).not.toContain('stat_balance(amount=40)');

    const buttons = buttonsOf(ctx);
    expect(
      buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals/exchange'),
    ).toBe(true);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/partner')).toBe(true);
  });

  it('says nothing about points once the partner has spent the last one', async () => {
    const getStatus = vi.fn().mockResolvedValue({ isActive: true });
    const getInfo = vi
      .fn()
      .mockResolvedValue({ balance: 100, totalEarned: 300, referralPoints: 0 });
    const getReferrals = vi.fn().mockResolvedValue({ total: 7 });
    const adminClient = {
      referrals: {},
      partner: { getStatus, getInfo, getReferrals },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 9 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    // The hub rendered — so the absences below are decisions, not a blank.
    expect(text).toContain('ru:partner.hub.title');
    expect(text).toContain('ru:partner.hub.stat_balance(amount=100)');
    expect(text).not.toContain('referral.hub.stat_points');

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/partner')).toBe(true);
    expect(
      buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals/exchange'),
    ).toBe(false);
  });

  it('treats a missing points field as nothing to say, not as a zero', async () => {
    // An older panel sends no such key. Absent is not a number, and a hub that
    // printed one would be inventing the customer's data.
    const getStatus = vi.fn().mockResolvedValue({ isActive: true });
    const getInfo = vi.fn().mockResolvedValue({ balance: 100, totalEarned: 300 });
    const getReferrals = vi.fn().mockResolvedValue({ total: 7 });
    const adminClient = {
      referrals: {},
      partner: { getStatus, getInfo, getReferrals },
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 9 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    expect(text).toContain('ru:partner.hub.title');
    expect(text).toContain('ru:partner.hub.stat_referred(count=7)');
    expect(text).not.toContain('referral.hub.stat_points');

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/partner')).toBe(true);
    expect(
      buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals/exchange'),
    ).toBe(false);
  });
});

describe('the shared message is plain text', () => {
  // The panel's picker puts `:slug:` pack emoji and `{{KEY}}` placeholders into
  // these texts, and Telegram's share sheet takes the text as a URL parameter,
  // which carries no entities: unresolved, the friend read the token itself.
  it('resolves emoji tokens to their glyphs, in the prompt and the website line', async () => {
    const adminClient = {
      referrals: {
        createInvite: vi.fn(),
        getSummary: vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' }),
      },
      partner: {},
    };
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient,
      publicWebUrl: 'https://reiwa.example',
      config: {
        ...DEFAULT_BOT_CONFIG,
        customEmojis: { fire: { id: '5368324170671202286', fallback: '🔥' } },
        botEmojiOwnerHasPremium: true,
      },
    });
    const operatorTexts: Record<string, string> = {
      'invite.share_prompt': ':fire: Привет! {{GIFT}} Попробуй',
      'invite.share_web_line': ':fire: Сайт: {{link}}',
    };
    const translator = {
      ...deps.translator,
      t: (key: string, lang: string, vars?: Record<string, string | number>) => {
        const text = operatorTexts[key];
        return text === undefined
          ? deps.translator.t(key, lang as never, vars)
          : text.replace('{{link}}', String(vars?.link ?? ''));
      },
    } as PageDeps['translator'];
    register(bot, { ...deps, translator });
    const ctx = buildFakeCtx({ from: { id: 5 } });

    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);

    const share = buttonsOf(ctx).find((b) => b.url?.startsWith('https://t.me/share/url?'));
    expect(share?.url).toBeDefined();
    expect(new URL(share!.url!).searchParams.get('text')).toBe(
      '🔥 Привет! 🎁 Попробуй\n\n🔥 Сайт: https://reiwa.example/ref/reiwa-id-1',
    );
  });
});

describe('the website link beside the Telegram one', () => {
  // The owner's order of 22.09.2026: an invite shared from the bot also carries
  // a link to the web cabinet, for a friend who would rather sign up in a
  // browser, or has no Telegram at all.
  const WEB = 'https://reiwa.example/ref/reiwa-id-1';

  async function openHub(options: {
    readonly publicWebUrl: string | null;
    readonly summary?: Record<string, unknown>;
    readonly createInvite?: ReturnType<typeof vi.fn>;
    readonly partner?: Record<string, unknown>;
    readonly username?: string;
  }) {
    const adminClient = {
      referrals: {
        createInvite: options.createInvite ?? vi.fn(),
        getSummary: vi.fn().mockResolvedValue(options.summary ?? { referralCode: 'reiwa-id-1' }),
      },
      partner: options.partner ?? {},
    } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: options.publicWebUrl,
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 5 }, ...(options.username === undefined ? {} : { me: { username: options.username } }) });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const text = ctx.editMessageText.mock.calls[0]?.[0] as string;
    const buttons = buttonsOf(ctx);
    const share = buttons.find((b) => b.url?.startsWith('https://t.me/share/url?'));
    const shared = share?.url === undefined ? null : new URL(share.url).searchParams.get('text');
    return { text, buttons, shared };
  }

  it('prints it, copies it, and puts it into the shared message', async () => {
    const { text, buttons, shared } = await openHub({ publicWebUrl: 'https://reiwa.example' });
    expect(text).toContain('https://t.me/reiwa_test_bot?start=ref_reiwa-id-1');
    expect(text).toContain(`ru:referral.hub.web_link_label\n${WEB}`);
    expect(buttons.some((b) => b.copy_text?.text === WEB)).toBe(true);
    // Telegram's share sheet takes one link and a text: the website link rides in the text.
    expect(shared).toBe(`ru:invite.share_prompt\n\nru:invite.share_web_line(link=${WEB})`);
  });

  it('carries the SAME single-use token under «только по приглашениям»: one friend, either link', async () => {
    const createInvite = vi.fn().mockResolvedValue({ invite: { token: 'tok-9' } });
    const { text, buttons } = await openHub({
      publicWebUrl: 'https://reiwa.example',
      summary: { referralCode: 'reiwa-id-1', admissionRequiresInvite: true },
      createInvite,
    });
    expect(text).toContain('https://t.me/reiwa_test_bot?start=ref_tok-9');
    expect(text).toContain('https://reiwa.example/ref/tok-9');
    expect(text).not.toContain('reiwa-id-1');
    expect(buttons.some((b) => b.copy_text?.text === 'https://reiwa.example/ref/tok-9')).toBe(true);
    expect(createInvite).toHaveBeenCalledTimes(1);
  });

  it('is not printed twice without a bot username — then the one link IS the website link', async () => {
    const { text, buttons, shared } = await openHub({ publicWebUrl: 'https://reiwa.example', username: '' });
    expect(text.split(WEB)).toHaveLength(2);
    expect(text).not.toContain('ru:referral.hub.web_link_label');
    expect(buttons.filter((b) => b.copy_text !== undefined)).toHaveLength(1);
    expect(shared).toBe('ru:invite.share_prompt');
  });

  it('is left out without a public HTTPS cabinet to send anybody to', async () => {
    // ANTI-VACUITY for the first case: the same hub, no cabinet.
    for (const publicWebUrl of [null, 'http://localhost:5173']) {
      const { text, buttons, shared } = await openHub({ publicWebUrl });
      expect(text, String(publicWebUrl)).not.toContain('/ref/');
      expect(buttons.filter((b) => b.copy_text !== undefined)).toHaveLength(1);
      expect(shared).toBe('ru:invite.share_prompt');
    }
  });

  it('reaches a partner’s hub too', async () => {
    const { text, buttons, shared } = await openHub({
      publicWebUrl: 'https://reiwa.example',
      partner: {
        getStatus: vi.fn().mockResolvedValue({ isActive: true }),
        getInfo: vi.fn().mockResolvedValue({ balance: 0, totalEarned: 0 }),
        getReferrals: vi.fn().mockResolvedValue({ total: 0 }),
      },
    });
    expect(text).toContain('ru:partner.hub.title');
    expect(text).toContain(`ru:referral.hub.web_link_label\n${WEB}`);
    expect(buttons.some((b) => b.copy_text?.text === WEB)).toBe(true);
    expect(shared).toBe(`ru:invite.share_prompt\n\nru:invite.share_web_line(link=${WEB})`);
  });
});

// The operator adds buttons to the `invite` screen in «Карта бота», as on help
// and rules — which render theirs above their own. The invite hub never read
// them: the map showed buttons the bot did not send.
describe('the operator’s own buttons on the invite screen', () => {
  const INVITE_SCREEN = {
    id: 'screen-invite',
    shortId: 'inv',
    name: 'invite',
    textRu: 'Приглашайте друзей: {{link}}',
    textEn: '',
    parseMode: 'plain' as const,
    mediaType: null,
    mediaFileId: null,
    mediaUrl: null,
    isRoot: false,
    buttons: [
      {
        id: 'b-terms',
        labelRu: 'Условия',
        labelEn: '',
        row: 0,
        col: 0,
        action: 'url' as const,
        targetShortId: null,
        url: 'https://reiwa.example/terms',
        webAppUrl: null,
        callbackAction: null,
        style: 'default' as const,
        iconCustomEmojiId: null,
      },
      {
        id: 'b-channel',
        labelRu: 'Канал',
        labelEn: '',
        row: 0,
        col: 1,
        action: 'url' as const,
        targetShortId: null,
        url: 'https://t.me/reiwa_news',
        webAppUrl: null,
        callbackAction: null,
        style: 'default' as const,
        iconCustomEmojiId: null,
      },
    ],
  };

  async function hubRows(admin: Record<string, unknown>): Promise<Btn[][]> {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: admin,
      publicWebUrl: 'https://reiwa.example',
      config: { ...DEFAULT_BOT_CONFIG, screens: [INVITE_SCREEN] },
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 5 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const opts = ctx.editMessageText.mock.calls[0]?.[1] as { reply_markup: { inline_keyboard: Btn[][] } };
    return opts.reply_markup.inline_keyboard;
  }

  const OPERATOR_ROW = [
    { text: 'Условия', url: 'https://reiwa.example/terms' },
    { text: 'Канал', url: 'https://t.me/reiwa_news' },
  ];

  it('come first on the referral hub, the hub’s own buttons below them', async () => {
    const rows = await hubRows({
      referrals: { getSummary: vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' }) },
      partner: {},
    });
    expect(rows[0]).toEqual(OPERATOR_ROW);
    expect(rows[1]?.[0]?.url?.startsWith('https://t.me/share/url?')).toBe(true);
    expect(rows.every((row) => row.length > 0)).toBe(true);
  });

  it('come first on the partner hub too', async () => {
    const rows = await hubRows({
      referrals: { getSummary: vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' }) },
      partner: {
        getStatus: vi.fn().mockResolvedValue({ isActive: true }),
        getInfo: vi.fn().mockResolvedValue({ balance: 0, totalEarned: 0 }),
        getReferrals: vi.fn().mockResolvedValue({ total: 0 }),
      },
    });
    expect(rows[0]).toEqual(OPERATOR_ROW);
    expect(rows[1]?.[0]?.url?.startsWith('https://t.me/share/url?')).toBe(true);
    expect(rows.every((row) => row.length > 0)).toBe(true);
  });

  it('leave a hub without an operator screen opening on its own share button, no empty row above it', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: {
        referrals: { getSummary: vi.fn().mockResolvedValue({ referralCode: 'reiwa-id-1' }) },
        partner: {},
      },
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx({ from: { id: 5 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const rows = (ctx.editMessageText.mock.calls[0]?.[1] as { reply_markup: { inline_keyboard: Btn[][] } })
      .reply_markup.inline_keyboard;
    expect(rows[0]?.[0]?.url?.startsWith('https://t.me/share/url?')).toBe(true);
    expect(rows.every((row) => row.length > 0)).toBe(true);
  });

  it('leave a partner with no link to share their cabinet button on a row of its own', async () => {
    const rows = await hubRows({
      referrals: { getSummary: vi.fn().mockResolvedValue(null) },
      partner: {
        getStatus: vi.fn().mockResolvedValue({ isActive: true }),
        getInfo: vi.fn().mockResolvedValue({ balance: 0, totalEarned: 0 }),
        getReferrals: vi.fn().mockResolvedValue({ total: 0 }),
      },
    });
    expect(rows[0]).toEqual(OPERATOR_ROW);
    expect(rows[1]).toEqual([{ text: 'ru:partner.hub.open_cabinet', web_app: { url: 'https://reiwa.example/partner' } }]);
    expect(rows.every((row) => row.length > 0)).toBe(true);
  });
});

// The three screens the invite button shows in place of a hub are translator
// keys «Тексты бота» can override, with the panel's emoji picker in the field.
// The hubs resolved their tokens; these three sent them raw.
describe('the invite button’s refusals carry the operator text, emoji tokens resolved', () => {
  async function refusal(
    key: string,
    options: { summary?: unknown; referralsEnabled?: boolean; publicWebUrl?: string | null; username?: string },
  ): Promise<{ text: string; entities: unknown }> {
    const adminClient = {
      referrals: { getSummary: vi.fn().mockResolvedValue(options.summary ?? null) },
      partner: {},
    };
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient,
      publicWebUrl: options.publicWebUrl ?? null,
      config: operatorEmojiConfig({
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: options.referralsEnabled ?? true },
      }),
    });
    register(bot, { ...deps, translator: withOperatorText(deps.translator, [key]) });
    const ctx = buildFakeCtx(options.username === undefined ? {} : { me: { username: options.username } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [text, opts] = ctx.editMessageText.mock.calls[0] as [string, { entities?: unknown }];
    return { text, entities: opts.entities };
  }

  it('the program switched off', async () => {
    expect(await refusal('referral.disabled', { referralsEnabled: false })).toEqual({
      text: OPERATOR_TEXT_GLYPHS,
      entities: [FIRE_ENTITY],
    });
  });

  it('the program open only to the invited', async () => {
    expect(
      await refusal('referral.invited_only', { summary: { referralCode: 'reiwa-id-1', programAvailable: false } }),
    ).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });

  it('no link to give', async () => {
    expect(
      await refusal('referral.link_unavailable', { summary: { referralCode: 'reiwa-id-1' }, username: '' }),
    ).toEqual({ text: OPERATOR_TEXT_GLYPHS, entities: [FIRE_ENTITY] });
  });
});
