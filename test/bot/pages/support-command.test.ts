import { describe, expect, it } from 'vitest';

import { registerSupportCommandPage } from '../../../src/bot/pages/support-command.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot, buildFakeCtx } from './helpers.js';

/**
 * `/support` — since 16.10.2026 the way into the support tickets.
 *
 * It used to switch the chat into a separate AI-support mode; clients got lost
 * between two supports, and the AI assistant moved into the tickets. So the
 * command opens «Поддержка» and nothing else: no mode, no chat in the bot.
 */

type Button = { text?: string; url?: string; callback_data?: string; web_app?: { url: string } };

function run(deps: PageDeps) {
  const bot = buildFakeBot();
  registerSupportCommandPage(bot as unknown as Parameters<typeof registerSupportCommandPage>[0], deps);
  const handler = bot.commandHandlers.get('support');
  if (handler === undefined) throw new Error('support handler was not registered');
  const ctx = buildFakeCtx();
  return { ctx, invoke: () => handler(ctx as unknown as BotContext) };
}

function reply(ctx: ReturnType<typeof buildFakeCtx>): { text: string; rows: Button[][] } {
  const [text, opts] = ctx.reply.mock.calls[0] as [string, { reply_markup: { inline_keyboard: Button[][] } }];
  return { text, rows: opts.reply_markup.inline_keyboard };
}

describe('/support', () => {
  it('opens the ticket page in the Mini App, the client staying in Telegram', async () => {
    const { deps } = buildDeps({ miniAppUrl: 'https://app.example.com/' });
    const { ctx, invoke } = run(deps);
    await invoke();

    const { text, rows } = reply(ctx);
    expect(text).toBe('ru:support_command.text');
    expect(rows[0]?.[0]?.web_app?.url).toBe('https://app.example.com/support');
    expect(rows[0]?.[0]?.text).toBe('ru:help.open_app_button');
    expect(rows[1]?.[0]?.callback_data).toBe('menu:main');
  });

  it('opens the cabinet in a browser when the operator has no Mini App', async () => {
    const { deps } = buildDeps({ publicWebUrl: 'https://cabinet.example.com' });
    const { ctx, invoke } = run(deps);
    await invoke();

    const { rows } = reply(ctx);
    expect(rows[0]?.[0]?.url).toBe('https://cabinet.example.com/support');
    expect(rows[0]?.[0]?.web_app).toBeUndefined();
  });

  it('admits there is nowhere to go rather than pointing at nothing', async () => {
    const { deps } = buildDeps();
    const { ctx, invoke } = run(deps);
    await invoke();

    const { text, rows } = reply(ctx);
    expect(text).toBe('ru:support.not_configured');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]?.callback_data).toBe('menu:main');
  });
});
