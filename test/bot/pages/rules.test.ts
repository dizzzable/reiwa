/**
 * `rules` callback page specs.
 *
 * The rules page renders STEALTHNET-style in place via `editOrReply`,
 * so assertions target `ctx.editMessageText` (the plain-text branch
 * taken when there is no `callbackQuery.message` to detect a photo).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { registerRulesPage } from '../../../src/bot/pages/rules.js';
import { setLegalDocumentsCache } from '../../../src/infrastructure/admin-client/legal-documents-cache.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

describe('registerRulesPage', () => {
  beforeEach(() => {
    setPolicyCache(null);
    // Both caches are process-wide singletons. Left bound, the first case's
    // fake client answers every later one through a 60-second TTL — which is
    // exactly what happened before this line existed.
    setLegalDocumentsCache(null);
  });

  it('registers a single callback handler for the "rules" callback', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('rules');
  });

  it('renders rules.unavailable when no admin client is configured', async () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:rules.unavailable', expect.anything());
  });

  it('renders rules.unavailable when policy.rulesLink is empty', async () => {
    const adminClient = ({
      system: { getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: '' }) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:rules.unavailable', expect.anything());
  });

  it('renders rules.intro with an inline url button when link is set', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://rules.example/legal' }),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.editMessageText.mock.calls[0];
    expect(text).toBe('ru:rules.intro');
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toBe('https://rules.example/legal');
  });

  /**
   * The operator's documents outrank the legacy external link.
   *
   * Both are "the rules" to a reader, and a bot that points somewhere other
   * than the sign-up form did is how the two quietly drift apart. A link and
   * not the text itself because a document caps at 40 000 characters while a
   * Telegram message caps at ~4096 — paginating a legal text across messages
   * is worse than one button to a page that scrolls.
   */
  it('sends the reader to the cabinet documents page once a document is enabled', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://old.example/legal' }),
      },
      legalDocuments: {
        list: vi.fn().mockResolvedValue([{ key: 'USER_AGREEMENT', title: 'A', body: 'B' }]),
      },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example/',
    });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [, opts] = ctx.editMessageText.mock.calls[0];
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toBe('https://reiwa.example/legal');
  });

  it('keeps the legacy link while no document has been published', async () => {
    const adminClient = ({
      system: {
        getPlatformPolicy: vi.fn().mockResolvedValue({ rulesLink: 'https://old.example/legal' }),
      },
      legalDocuments: { list: vi.fn().mockResolvedValue([]) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({
      adminOverrides: adminClient as unknown as Record<string, unknown>,
      publicWebUrl: 'https://reiwa.example',
    });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    const [, opts] = ctx.editMessageText.mock.calls[0];
    const kb = (opts as { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } })
      .reply_markup;
    expect(kb.inline_keyboard[0][0].url).toBe('https://old.example/legal');
  });

  it('falls back to rules.unavailable when getPlatformPolicy throws', async () => {
    const adminClient = ({
      system: { getPlatformPolicy: vi.fn().mockRejectedValue(new Error('boom')) },
    } as unknown) as PageDeps['adminClient'];
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides: adminClient as unknown as Record<string, unknown> });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const ctx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(ctx as unknown as BotContext);
    expect(ctx.editMessageText).toHaveBeenCalledWith('ru:rules.unavailable', expect.anything());
  });
});
