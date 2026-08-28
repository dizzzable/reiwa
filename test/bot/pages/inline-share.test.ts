import { describe, expect, it, vi } from 'vitest';

import { registerInlineSharePage } from '../../../src/bot/pages/inline-share.js';
import { DEFAULT_BOT_CONFIG } from '../../../src/infrastructure/bot-config/cache.js';
import type { BotConfig } from '../../../src/infrastructure/bot-config/types.js';
import { buildDeps, buildFakeBot, buildFakeInlineCtx } from './helpers.js';

/**
 * Inline mode.
 *
 * An inline query is the only traffic this bot answers that does not come from
 * a chat, and every one of its differences is a way to break quietly:
 *
 *   • `is_personal` is what keeps one sender's referral code out of the next
 *     sender's composer. Omit it and nothing fails — Telegram just starts
 *     serving a cached answer keyed on the query text, and the first person to
 *     notice is whoever's referrals stop being attributed. It is asserted on
 *     every answer here, including the empty one.
 *   • `ctx.session` THROWS on an inline query rather than returning empty,
 *     because grammY's session key is the chat id and there is no chat. The
 *     fixture omits `chat` entirely so a page that reaches for either is caught.
 *   • The sender may be a stranger with no account. The handler must still
 *     answer something usable, and must not promise a referral bonus for a link
 *     that carries no referral code.
 *   • It fires per keystroke, so the admin lookup is memoised. A regression
 *     there is invisible in production until it shows up as load.
 */

function handlerFor(deps: ReturnType<typeof buildDeps>['deps']) {
  const bot = buildFakeBot();
  registerInlineSharePage(bot as never, deps);
  const handler = bot.updateHandlers.get('inline_query');
  if (handler === undefined) throw new Error('inline_query handler was not registered');
  return handler;
}

function configWithReferrals(enabled: boolean): BotConfig {
  return {
    ...DEFAULT_BOT_CONFIG,
    features: { ...DEFAULT_BOT_CONFIG.features, referralsEnabled: enabled },
  };
}

describe('inline share', () => {
  it('offers the sender their own referral link', async () => {
    const getSummary = vi.fn(async () => ({ referralCode: 'ref-code-1' }));
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary } } });
    const ctx = buildFakeInlineCtx({ from: { id: 7 } });

    await handlerFor(deps)(ctx as never);

    expect(ctx.answerInlineQuery).toHaveBeenCalledOnce();
    const [results, options] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0])).toContain(
      'https://t.me/reiwa_test_bot?start=ref_ref-code-1',
    );
    // The one flag that has to be right.
    expect(options.is_personal).toBe(true);
    // A stranger prompt would be wrong here — this sender has an account.
    expect(options.button).toBeUndefined();
  });

  it('never touches the chat or the session, because there is neither', async () => {
    const { deps } = buildDeps({
      adminOverrides: { referrals: { getSummary: async () => ({ referralCode: 'c' }) } },
    });
    const ctx = buildFakeInlineCtx();

    await handlerFor(deps)(ctx as never);

    // Positive control: it DID answer, so the two absences below are about the
    // handler's behaviour and not about it bailing out early.
    expect(ctx.answerInlineQuery).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
    expect((ctx as { chat?: unknown }).chat).toBeUndefined();
  });

  it('still answers a stranger, with the plain bot link and a way in', async () => {
    // Nobody upstream knows this telegram id — the ordinary case for inline
    // mode, which reaches people who have never opened the bot.
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary: async () => ({}) } } });
    const ctx = buildFakeInlineCtx();

    await handlerFor(deps)(ctx as never);

    const [results, options] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
      Record<string, unknown>,
    ];
    const payload = JSON.stringify(results[0]);
    expect(payload).toContain('https://t.me/reiwa_test_bot');
    // No referral code went out, so no bonus may be promised for it.
    expect(payload).toContain('_plain');
    expect(payload).not.toContain('start=ref_');
    expect(options.is_personal).toBe(true);
    // The composer button is how a stranger gets from "shared a link" to
    // "has their own link".
    expect(options.button).toMatchObject({ start_parameter: 'inline' });
  });

  it('refuses to hand out a permanent code under invited-only admission', async () => {
    // In that mode only a single-use token admits a sign-up, so this link would
    // be refused at registration — and minting one here would spend the user's
    // invite quota on a keystroke.
    const getSummary = vi.fn(async () => ({
      referralCode: 'ref-code-1',
      admissionRequiresInvite: true,
    }));
    const createInvite = vi.fn(async () => ({ token: 'should-not-be-minted' }));
    const { deps } = buildDeps({
      adminOverrides: { referrals: { getSummary, createInvite } },
    });

    await handlerFor(deps)(buildFakeInlineCtx() as never);

    expect(createInvite).not.toHaveBeenCalled();
  });

  it('drops the referral code when the operator switched referrals off', async () => {
    const getSummary = vi.fn(async () => ({ referralCode: 'ref-code-1' }));
    const { deps } = buildDeps({
      config: configWithReferrals(false),
      adminOverrides: { referrals: { getSummary } },
    });
    const ctx = buildFakeInlineCtx();

    await handlerFor(deps)(ctx as never);

    const [results] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
    ];
    expect(JSON.stringify(results[0])).not.toContain('start=ref_');
    // Not even asked — the answer is decided before the lookup.
    expect(getSummary).not.toHaveBeenCalled();
  });

  it('asks upstream once per user, not once per keystroke', async () => {
    // Telegram sends an inline query on every character typed. Without the
    // memo this is one admin round-trip per keystroke, per user, forever — a
    // load problem that never surfaces as an error.
    const getSummary = vi.fn(async () => ({ referralCode: 'ref-code-1' }));
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary } } });
    const handler = handlerFor(deps);

    for (const query of ['r', 're', 'rei', 'reiw', 'reiwa']) {
      await handler(buildFakeInlineCtx({ from: { id: 7 }, query }) as never);
    }
    // A different sender is a different answer and must not reuse the memo.
    await handler(buildFakeInlineCtx({ from: { id: 8 } }) as never);

    expect(getSummary).toHaveBeenCalledTimes(2);
  });

  it('degrades to the plain link when the admin lookup fails', async () => {
    const { deps } = buildDeps({
      adminOverrides: {
        referrals: {
          getSummary: async () => {
            throw new Error('rezeis unreachable');
          },
        },
      },
    });
    const ctx = buildFakeInlineCtx();

    await handlerFor(deps)(ctx as never);

    // Answering nothing would show an empty composer to everyone in the chat,
    // which reads as a broken bot rather than as a degraded one.
    expect(ctx.answerInlineQuery).toHaveBeenCalledOnce();
    const [results] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
    ];
    expect(results).toHaveLength(1);
  });

  it('answers empty rather than posting a broken invite when it has no link at all', async () => {
    // No bot username and no public URL: a dev process with nothing to point
    // at. `is_personal` is still set — an empty answer is cached too.
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary: async () => ({}) } } });
    const ctx = buildFakeInlineCtx({ me: { username: '' } });

    await handlerFor(deps)(ctx as never);

    const [results, options] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<unknown>,
      Record<string, unknown>,
    ];
    expect(results).toStrictEqual([]);
    expect(options.is_personal).toBe(true);
  });

  it('swallows a failed answer instead of routing it into bot.catch', async () => {
    // `bot.catch` apologises by replying into a chat. An inline query has none,
    // so the apology itself throws and the original error is what gets lost.
    const { deps } = buildDeps({
      adminOverrides: { referrals: { getSummary: async () => ({ referralCode: 'c' }) } },
    });
    const ctx = buildFakeInlineCtx();
    ctx.answerInlineQuery.mockRejectedValue(new Error('query is too old'));

    await expect(handlerFor(deps)(ctx as never)).resolves.toBeUndefined();
  });

  it('offers no referral link once the program itself is switched off', async () => {
    // The gate used to read the BOT CARD's `features.referralsEnabled`, which
    // is a different operator switch from the one the payout engine consults.
    // Pausing the program on the Referrals settings page — the ordinary way to
    // stop paying — clears the engine's switch and leaves the bot toggle alone:
    // the cabinet card correctly disappeared while inline mode kept answering
    // "your friend gets access, you get a bonus" with a live link. Those get
    // pasted into chats and channels and stay there, and every friend who signs
    // up through one creates a referral that is never rewarded.
    const getSummary = vi.fn(async () => ({
      referralCode: 'ref-code-1',
      program: { enabled: false },
    }));
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary } } });
    const ctx = buildFakeInlineCtx({ from: { id: 7 } });

    await handlerFor(deps)(ctx as never);

    const [results] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
    ];
    // It still ANSWERS — silence would look like a broken bot to everyone in
    // the chat — but with the plain bot link rather than a referral promise.
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain('ref-code-1');
  });

  it('still offers the link while the program is paying', async () => {
    // Positive control: the refusal has to be about the switch, not about the
    // fixture having drifted into refusing everything.
    const getSummary = vi.fn(async () => ({
      referralCode: 'ref-code-1',
      program: { enabled: true },
    }));
    const { deps } = buildDeps({ adminOverrides: { referrals: { getSummary } } });
    const ctx = buildFakeInlineCtx({ from: { id: 7 } });

    await handlerFor(deps)(ctx as never);

    const [results] = ctx.answerInlineQuery.mock.calls[0] as [
      ReadonlyArray<Record<string, unknown>>,
    ];
    expect(JSON.stringify(results)).toContain('ref-code-1');
  });
});
