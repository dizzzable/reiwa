/**
 * Referral page specs.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerReferralPage } from '../../../src/bot/pages/referral.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

function buildAdmin(opts: {
  summary?: unknown;
  inviteToken?: string | null;
}): PageDeps['adminClient'] {
  return ({
    referrals: {
      getSummary: vi.fn().mockResolvedValue(opts.summary ?? null),
      createInvite: vi
        .fn()
        .mockResolvedValue(opts.inviteToken !== undefined ? { token: opts.inviteToken } : null),
    },
  } as unknown) as PageDeps['adminClient'];
}

describe('registerReferralPage', () => {
  it('registers /referral command + referrals callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerReferralPage(bot as unknown as Parameters<typeof registerReferralPage>[0], deps);
    expect(bot.commandHandlers.has('referral')).toBe(true);
    expect(bot.callbackHandlers[0].matcher).toBe('referrals');
  });

  it('replies with referral.disabled when feature flag is off', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      },
    });
    registerReferralPage(bot as unknown as Parameters<typeof registerReferralPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('referral')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:referral.disabled');
  });

  it('renders the full referral card when admin returns summary + token', async () => {
    const adminClient = buildAdmin({
      summary: { totalReferrals: 5, qualifiedReferrals: 2 },
      inviteToken: 'tok-1',
    });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    registerReferralPage(bot as unknown as Parameters<typeof registerReferralPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('referral')!(ctx as unknown as BotContext);
    const [text] = ctx.reply.mock.calls[0];
    expect(text).toContain('Приглашено: 5');
    expect(text).toContain('Квалифицировано: 2');
    expect(text).toContain('https://reiwa.example/ref/tok-1');
  });

  it('falls back to referral.link_unavailable when no token is returned', async () => {
    const adminClient = buildAdmin({ summary: { totalReferrals: 0 }, inviteToken: null });
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerReferralPage(bot as unknown as Parameters<typeof registerReferralPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('referral')!(ctx as unknown as BotContext);
    expect(ctx.reply.mock.calls[0][0]).toContain('ru:referral.link_unavailable');
  });

  it('falls back to referral.error when admin throws', async () => {
    const adminClient = ({
      get referrals() {
        throw new Error('explosion');
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerReferralPage(bot as unknown as Parameters<typeof registerReferralPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('referral')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:referral.error');
  });
});
