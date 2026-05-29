/**
 * `invite` callback page specs.
 *
 * Renders STEALTHNET-style in place via `editOrReply`, so assertions
 * target `ctx.editMessageText`. createInvite now takes a UserIdentity
 * `{ telegramId }` (reiwa_id-first contract).
 */
import { describe, expect, it, vi } from 'vitest';

import { registerInvitePage } from '../../../src/bot/pages/invite.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerInvitePage', () => {
  it('registers a single callback handler for the "invite" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('invite');
  });

  it('renders referral.disabled when feature flag is off', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      },
    });
    registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:referral.disabled', expect.anything());
  });

  it('builds the invite link from token + publicWebUrl', async () => {
    const createInvite = vi.fn().mockResolvedValue({ token: 'tok-1' });
    const adminClient = ({ referrals: { createInvite } } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
    const ctx = buildFakeCtx({ from: { id: 5 } });
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'ru:invite.share(link=https://reiwa.example/ref/tok-1)',
      expect.anything(),
    );
    expect(createInvite).toHaveBeenCalledWith({ telegramId: '5' });
  });

  it('falls back to referral.link_unavailable when no token is returned', async () => {
    const createInvite = vi.fn().mockResolvedValue(null);
    const adminClient = ({ referrals: { createInvite } } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith(
      'ru:referral.link_unavailable',
      expect.anything(),
    );
  });

  it('renders referral.error when admin throws', async () => {
    const createInvite = vi.fn();
    // The page wraps createInvite in `.catch(() => null)`, so to hit the
    // outer try/catch we throw synchronously from the `referrals` getter.
    const adminClient = ({
      get referrals(): never {
        throw new Error('explosion');
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerInvitePage(bot as unknown as Parameters<typeof registerInvitePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:referral.error', expect.anything());
    expect(createInvite).not.toHaveBeenCalled();
  });
});
