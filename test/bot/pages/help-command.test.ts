/**
 * `/help` command page specs.
 */
import { describe, expect, it } from 'vitest';

import { registerHelpCommandPage } from '../../../src/bot/pages/help.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotContext } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerHelpCommandPage', () => {
  it('registers a /help command handler', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    expect(bot.commandHandlers.has('help')).toBe(true);
  });

  it('renders the static command list with conditional promo + referral lines', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).toContain('ru:help.title');
    expect(reply).toContain('ru:help.start');
    expect(reply).toContain('ru:help.subscription');
    expect(reply).toContain('ru:help.plans');
    expect(reply).toContain('ru:help.profile');
    expect(reply).toContain('ru:help.lang');
    expect(reply).toContain('ru:help.help');
    // Default config has both flags on.
    expect(reply).toContain('ru:help.promo');
    expect(reply).toContain('ru:help.referral');
  });

  it('omits help.promo when the operator has promo codes off', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, promoCodesEnabled: false },
      },
    });
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).not.toContain('ru:help.promo');
    expect(reply).toContain('ru:help.referral');
  });

  it('omits help.referral when the operator has referrals off', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: false },
      },
    });
    registerHelpCommandPage(
      bot as unknown as Parameters<typeof registerHelpCommandPage>[0],
      deps,
    );
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('help')!(ctx as unknown as BotContext);
    const reply = ctx.reply.mock.calls[0][0] as string;
    expect(reply).not.toContain('ru:help.referral');
    expect(reply).toContain('ru:help.promo');
  });
});
