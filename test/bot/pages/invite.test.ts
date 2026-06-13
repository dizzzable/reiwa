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
    const createInvite = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const getSummary = vi
      .fn()
      .mockResolvedValue({ totalReferrals: 3, qualifiedReferrals: 1, pointsBalance: 50 });
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
    expect(text).toContain('https://reiwa.example/ref/tok-1');
    expect(text).toContain('ru:referral.hub.stat_invited(count=3)');
    expect(text).toContain('ru:referral.hub.stat_qualified(count=1)');
    expect(text).toContain('ru:referral.hub.stat_pending(count=2)');
    expect(text).toContain('ru:referral.hub.stat_points(count=50)');

    const buttons = buttonsOf(ctx);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals')).toBe(true);
    expect(buttons.some((b) => b.web_app?.url === 'https://reiwa.example/referrals/exchange')).toBe(true);
    // Read-only money path — the hub never performs an exchange.
    expect(exchange).not.toHaveBeenCalled();
    expect(createInvite).toHaveBeenCalledWith({ telegramId: '5' });
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

  it('falls back to referral.link_unavailable when no token is returned', async () => {
    const createInvite = vi.fn().mockResolvedValue(null);
    const adminClient = { referrals: { createInvite } } as unknown as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    register(bot, deps);
    const ctx = buildFakeCtx();
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
});
