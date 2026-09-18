/**
 * `t.me/<bot>?start=pwreset` — the bot sends a password reset link to the
 * Telegram user it is talking to, naming the login (they may have forgotten it).
 *
 * Driven through the real `/start` handler, because where the branch sits is
 * half of the behaviour: it must answer before the access-mode check (which
 * would read an unknown payload as a referral code), before bootstrap and
 * before the channel gate. The other half is where the button points — only
 * ever at this bot's own cabinet address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChannelGateMemory } from '../../../src/bot/lib/channel-gate.js';
import { passwordResetUrl, PASSWORD_RESET_START_PAYLOAD } from '../../../src/bot/pages/password-reset.js';
import { registerStartPage } from '../../../src/bot/pages/start.js';
import { setPolicyCache } from '../../../src/infrastructure/admin-client/policy-cache.js';
import type { WebAuthNamespace } from '../../../src/infrastructure/admin-client/namespaces/web-auth.js';
import type { BotContext, PageDeps } from '../../../src/bot/pages/types.js';
import { buildDeps, buildFakeBot } from './helpers.js';

type Issue = WebAuthNamespace['issuePasswordResetForTelegram'];
type IssueResult = Awaited<ReturnType<Issue>>;

const TOKEN = 'e'.repeat(64);
const CABINET = 'https://cabinet.example.com';

function adminWith(issue: Issue) {
  const issuePasswordResetForTelegram = vi.fn(issue);
  const webAuth: Pick<WebAuthNamespace, 'issuePasswordResetForTelegram'> = { issuePasswordResetForTelegram };
  const bootstrap = vi.fn(async () => null);
  const exists = vi.fn(async () => ({ exists: false }));
  const getPlatformPolicy = vi.fn(async () => ({ accessMode: 'INVITED' }));
  const client = { webAuth, user: { bootstrap, exists }, system: { getPlatformPolicy } };
  return { client: client as unknown as PageDeps['adminClient'], issuePasswordResetForTelegram, bootstrap, exists };
}

function ctxFor(payload: string) {
  return {
    from: { id: 700001, first_name: 'Alice' },
    chat: { id: 700001, type: 'private' },
    match: payload,
    api: { getChatMember: vi.fn() },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
  };
}

async function start(payload: string, admin: PageDeps['adminClient'], publicWebUrl: string | null = CABINET) {
  const bot = buildFakeBot();
  const { deps } = buildDeps({ publicWebUrl, adminOverrides: admin ?? undefined });
  registerStartPage(bot as unknown as Parameters<typeof registerStartPage>[0], deps);
  const ctx = ctxFor(payload);
  await bot.commandHandlers.get('start')!(ctx as unknown as BotContext);
  return ctx;
}

interface Button {
  readonly text: string;
  readonly url?: string;
}

function onlyReply(ctx: ReturnType<typeof ctxFor>): { text: string; buttons: Button[] } {
  expect(ctx.reply).toHaveBeenCalledTimes(1);
  const [text, options] = ctx.reply.mock.calls[0] as [string, { reply_markup?: { inline_keyboard: Button[][] } } | undefined];
  return { text, buttons: options?.reply_markup?.inline_keyboard.flat() ?? [] };
}

describe('/start pwreset', () => {
  beforeEach(() => {
    setPolicyCache(null);
    resetChannelGateMemory();
  });

  it('is the payload the cabinet links to', () => {
    expect(PASSWORD_RESET_START_PAYLOAD).toBe('pwreset');
  });

  it('sends the link behind a button on the cabinet address, names the login, and touches nothing else', async () => {
    const admin = adminWith(async () => ({
      status: 'issued',
      token: TOKEN,
      login: 'Alice',
      expiresAt: '2026-09-18T12:15:00.000Z',
    }));

    const ctx = await start('pwreset', admin.client);

    expect(admin.issuePasswordResetForTelegram.mock.calls).toEqual([['700001']]);
    const { text, buttons } = onlyReply(ctx);
    expect(text).toBe('ru:password_reset.link(login=Alice)');
    // In the fragment: no server log or Referer ever sees it.
    expect(buttons).toEqual([{ text: 'ru:password_reset.button', url: `${CABINET}/reset-password#token=${TOKEN}` }]);
    // Ahead of everything a normal /start does: under INVITED an unknown
    // payload from a stranger would otherwise be refused as a bad referral.
    expect(admin.bootstrap).not.toHaveBeenCalled();
    expect(admin.exists).not.toHaveBeenCalled();
    expect(ctx.api.getChatMember).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, IssueResult | 'throws', string]> = [
    ['a Telegram user without a web login', { status: 'no_account' }, 'ru:password_reset.no_account'],
    ['a link sent a moment ago', { status: 'recently_sent' }, 'ru:password_reset.recently_sent'],
    ['the hour’s five links already sent', { status: 'hourly_limit' }, 'ru:password_reset.hourly_limit'],
    ['a panel that could not store or count', { status: 'unavailable' }, 'ru:password_reset.unavailable'],
    ['an older panel without the route', 'throws', 'ru:password_reset.unavailable'],
  ];
  for (const [situation, answer, key] of refusals) {
    it(`says so, with no button, for ${situation}`, async () => {
      const admin = adminWith(async () => {
        if (answer === 'throws') throw new Error('AdminClient: POST /api/internal/web-auth/password-reset/telegram → 404');
        return answer;
      });

      const { text, buttons } = onlyReply(await start('pwreset', admin.client));

      expect(text).toBe(key);
      expect(buttons).toEqual([]);
    });
  }

  it('does not even ask the panel when the bot has no safe cabinet address', async () => {
    const admin = adminWith(async () => ({ status: 'issued', token: TOKEN, login: 'Alice', expiresAt: '' }));

    const { text, buttons } = onlyReply(await start('pwreset', admin.client, null));

    expect(text).toBe('ru:password_reset.unavailable');
    expect(buttons).toEqual([]);
    expect(admin.issuePasswordResetForTelegram).not.toHaveBeenCalled();
  });
});

describe('passwordResetUrl', () => {
  it('puts the token on the cabinet ORIGIN only, in the fragment', () => {
    const href = passwordResetUrl('https://cabinet.example.com/some/path?x=1#y', TOKEN);
    expect(href).toBe(`https://cabinet.example.com/reset-password#token=${TOKEN}`);
    expect(new URL(href!).search).toBe('');
  });

  it('refuses anything Telegram would reject or that is not a token', () => {
    expect(passwordResetUrl('http://cabinet.example.com', TOKEN)).toBeNull();
    expect(passwordResetUrl('https://localhost:5173', TOKEN)).toBeNull();
    expect(passwordResetUrl('not a url', TOKEN)).toBeNull();
    expect(passwordResetUrl(null, TOKEN)).toBeNull();
    expect(passwordResetUrl(CABINET, 'x'.repeat(64))).toBeNull();
    expect(passwordResetUrl(CABINET, `${TOKEN}&next=https://evil.example`)).toBeNull();
  });
});
