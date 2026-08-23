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
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

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
