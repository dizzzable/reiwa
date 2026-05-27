/**
 * Profile page specs.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerProfilePage } from '../../../src/bot/pages/profile.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

const SESSION = {
  name: 'Anya',
  username: 'anya_x',
  language: 'en',
  points: 42,
  personalDiscount: 10,
  referralCode: 'AB12CD',
  hasSubscription: true,
};

describe('registerProfilePage', () => {
  it('registers /profile command + profile callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerProfilePage(bot as unknown as Parameters<typeof registerProfilePage>[0], deps);
    expect(bot.commandHandlers.has('profile')).toBe(true);
    expect(bot.callbackHandlers[0].matcher).toBe('profile');
  });

  it('replies with error_generic when no admin client', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerProfilePage(bot as unknown as Parameters<typeof registerProfilePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('profile')!(ctx as unknown as BotContext);
    expect(ctx.reply).toHaveBeenCalledWith('ru:error_generic');
  });

  it('renders the full session card when admin returns data', async () => {
    const adminClient = ({
      user: { getSession: vi.fn().mockResolvedValue(SESSION) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerProfilePage(bot as unknown as Parameters<typeof registerProfilePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('profile')!(ctx as unknown as BotContext);
    const [text, opts] = ctx.reply.mock.calls[0];
    expect(text).toContain('ru:profile.header');
    expect(text).toContain('ru:profile.name(name=Anya)');
    expect(text).toContain('ru:profile.username(username=anya_x)');
    expect(text).toContain('ru:profile.language(lang=EN)');
    expect(text).toContain('ru:profile.points(points=42)');
    expect(text).toContain('ru:profile.discount(discount=10)');
    expect(text).toContain('ru:profile.referral_code(code=AB12CD)');
    expect(text).toContain('ru:profile.has_subscription');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<unknown[]> } }).reply_markup;
    expect(kb.inline_keyboard.length).toBeGreaterThanOrEqual(2);
  });

  it('omits username + discount when not provided', async () => {
    const adminClient = ({
      user: {
        getSession: vi.fn().mockResolvedValue({
          name: 'X',
          language: 'ru',
          points: 0,
          referralCode: '—',
          hasSubscription: false,
        }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerProfilePage(bot as unknown as Parameters<typeof registerProfilePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.commandHandlers.get('profile')!(ctx as unknown as BotContext);
    const text = ctx.reply.mock.calls[0][0] as string;
    expect(text).not.toContain('profile.username');
    expect(text).not.toContain('profile.discount');
    expect(text).toContain('ru:profile.no_subscription');
  });

  it('callback acks before rendering', async () => {
    const adminClient = ({
      user: { getSession: vi.fn().mockResolvedValue(SESSION) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
    });
    registerProfilePage(bot as unknown as Parameters<typeof registerProfilePage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});
