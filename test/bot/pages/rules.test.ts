/**
 * Rules screen specs — one screen, two doors.
 *
 * The CALLBACK renders STEALTHNET-style in place via `editOrReply`, so its
 * assertions target `ctx.editMessageText` (the plain-text branch taken when
 * there is no `callbackQuery.message` to detect a photo).
 *
 * The COMMAND cannot do that. `/rules` was advertised in Telegram’s `/`
 * autocomplete with no handler at all, and the obvious fix — point the
 * command at the callback body — would have been wrong in a way that only
 * shows up against a real Telegram: with no previous screen to replace,
 * `editOrReply` aims `editMessageText` at the message the USER just sent, and
 * Telegram refuses to edit that. Hence a shared builder and two deliveries,
 * and hence the assertions below that the command sends and does not edit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { registerRulesPage } from '../../../src/bot/pages/rules.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
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

  it('registers both doors to the screen: the callback and the command', () => {
    const bot = buildFakeBot();
    const { deps } = buildDeps();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    expect(bot.callbackHandlers).toHaveLength(1);
    expect(bot.callbackHandlers[0].matcher).toBe('rules');
    expect(bot.commandHandlers.has('rules')).toBe(true);
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

describe('the /rules command', () => {
  beforeEach(() => {
    setPolicyCache(null);
    setLegalDocumentsCache(null);
  });

  function runCommand(deps: PageDeps) {
    const bot = buildFakeBot();
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const handler = bot.commandHandlers.get('rules');
    if (handler === undefined) throw new Error('rules command was not registered');
    const ctx = buildFakeCtx();
    return { ctx, invoke: () => handler(ctx as unknown as BotContext) };
  }

  it('sends a fresh message instead of editing the user\u2019s own', async () => {
    const { deps } = buildDeps();
    const { ctx, invoke } = runCommand(deps);
    await invoke();

    expect(ctx.reply).toHaveBeenCalledWith('ru:rules.unavailable', expect.anything());
    // The whole reason the body is shared through a builder rather than
    // called directly: this edit would fail against Telegram every time.
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.editMessageCaption).not.toHaveBeenCalled();
    // And no callback to answer — a command has none.
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();
  });

  it('renders the same screen the button renders', async () => {
    // Same policy, same link, same copy, same buttons. The two doors are only
    // allowed to differ in HOW the message is delivered — if they ever differ
    // in WHAT it says, the operator edited one screen and got two.
    const adminOverrides = {
      system: {
        getPlatformPolicy: async () => ({ rulesLink: 'https://rules.example/legal' }),
      },
    } as unknown as Record<string, unknown>;

    const viaCommand = runCommand(buildDeps({ adminOverrides }).deps);
    await viaCommand.invoke();
    const [commandText, commandOpts] = viaCommand.ctx.reply.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];

    setPolicyCache(null);
    setLegalDocumentsCache(null);
    const bot = buildFakeBot();
    const { deps } = buildDeps({ adminOverrides });
    registerRulesPage(bot as unknown as Parameters<typeof registerRulesPage>[0], deps);
    const callbackCtx = buildFakeCtx();
    await bot.callbackHandlers[0].handler(callbackCtx as unknown as BotContext);
    const [callbackText, callbackOpts] = callbackCtx.editMessageText.mock.calls[0] as [
      string,
      { reply_markup: { inline_keyboard: Array<Array<{ url?: string }>> } },
    ];

    expect(commandText).toBe(callbackText);
    expect(commandText).toBe('ru:rules.intro');
    expect(commandOpts.reply_markup.inline_keyboard).toStrictEqual(
      callbackOpts.reply_markup.inline_keyboard,
    );
    expect(commandOpts.reply_markup.inline_keyboard[0]?.[0]?.url).toBe(
      'https://rules.example/legal',
    );
  });

  it('carries an operator\u2019s HTML screen as HTML, not as raw tags', async () => {
    // `replyWithOptionalBanner` had no `parseMode` at all — it was written for
    // `/help` and `/lang`, neither of which renders operator markup. Passing
    // one through a conditional SPREAD compiles silently (TypeScript does not
    // apply excess-property checks to spreads), so the command would have
    // shown the operator raw `<b>` tags while the button route rendered them.
    const { deps } = buildDeps({
      config: {
        ...DEFAULT_BOT_CONFIG,
        screens: [
          {
            id: 'screen-rules',
            shortId: 'rul',
            name: 'rules',
            textRu: '<b>Правила</b>',
            textEn: '<b>Rules</b>',
            parseMode: 'html',
            mediaType: null,
            mediaFileId: null,
            mediaUrl: null,
            isRoot: false,
            buttons: [],
          },
        ],
      },
    });
    const { ctx, invoke } = runCommand(deps);
    await invoke();

    const [text, opts] = ctx.reply.mock.calls[0] as [
      string,
      { parse_mode?: string; entities?: unknown },
    ];
    expect(text).toBe('<b>Правила</b>');
    expect(opts.parse_mode).toBe('HTML');
    // Telegram takes one or the other; sending both makes it ignore one
    // silently, which is how a half-rendered screen happens.
    expect(opts.entities).toBeUndefined();
  });
});
