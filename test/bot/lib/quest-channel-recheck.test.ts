/**
 * Bot-owned periodic channel recheck.
 *
 * rezeis owns quest state but has no Telegram token, so the bot pulls bounded
 * candidates, probes live membership with its own `getChatMember`, and reports
 * each result back. A negative result reverts an unclaimed completion; a
 * Telegram error is skipped (left for the next tick) — never reported as a
 * false positive, and never reported as negative on a transient outage.
 */
import { describe, expect, it, vi } from 'vitest';

import { runQuestChannelRecheck } from '../../../src/bot/lib/quest-channel-recheck.js';

function candidate(over: Record<string, unknown> = {}) {
  return {
    questId: 'cmphfcr6i007v01jg0lcu653h',
    telegramId: '42',
    chatId: '-1001234567890',
    joinUrl: 'https://t.me/rezeis',
    ...over,
  };
}

describe('runQuestChannelRecheck', () => {
  it('reports isMember=true for a still-subscribed candidate', async () => {
    const recheckChannel = vi.fn().mockResolvedValue({ state: 'COMPLETED' });
    const adminClient = {
      quests: {
        channelRecheckCandidates: vi.fn().mockResolvedValue([candidate()]),
        recheckChannel,
      },
    };
    const api = { getChatMember: vi.fn().mockResolvedValue({ status: 'member' }) };

    const stats = await runQuestChannelRecheck({ adminClient: adminClient as never, api: api as never });

    expect(api.getChatMember).toHaveBeenCalledWith('-1001234567890', 42);
    expect(recheckChannel).toHaveBeenCalledWith({
      telegramId: '42',
      questId: 'cmphfcr6i007v01jg0lcu653h',
      isMember: true,
    });
    expect(stats).toEqual({ checked: 1, reverted: 0, skipped: 0 });
  });

  it('reports isMember=false when membership was lost (revokes claimability)', async () => {
    const recheckChannel = vi.fn().mockResolvedValue({ state: 'IN_PROGRESS' });
    const adminClient = {
      quests: {
        channelRecheckCandidates: vi.fn().mockResolvedValue([candidate()]),
        recheckChannel,
      },
    };
    const api = { getChatMember: vi.fn().mockResolvedValue({ status: 'left' }) };

    const stats = await runQuestChannelRecheck({ adminClient: adminClient as never, api: api as never });

    expect(recheckChannel).toHaveBeenCalledWith({
      telegramId: '42',
      questId: 'cmphfcr6i007v01jg0lcu653h',
      isMember: false,
    });
    expect(stats.reverted).toBe(1);
  });

  it('skips a candidate on a Telegram error — never reports a result', async () => {
    const recheckChannel = vi.fn();
    const adminClient = {
      quests: {
        channelRecheckCandidates: vi.fn().mockResolvedValue([candidate()]),
        recheckChannel,
      },
    };
    const api = { getChatMember: vi.fn().mockRejectedValue(new Error('502')) };

    const stats = await runQuestChannelRecheck({ adminClient: adminClient as never, api: api as never });

    expect(recheckChannel).not.toHaveBeenCalled();
    expect(stats).toEqual({ checked: 0, reverted: 0, skipped: 1 });
  });

  it('treats restricted with is_member=false as not a member', async () => {
    const recheckChannel = vi.fn().mockResolvedValue({ state: 'IN_PROGRESS' });
    const adminClient = {
      quests: {
        channelRecheckCandidates: vi.fn().mockResolvedValue([candidate()]),
        recheckChannel,
      },
    };
    const api = { getChatMember: vi.fn().mockResolvedValue({ status: 'restricted', is_member: false }) };

    await runQuestChannelRecheck({ adminClient: adminClient as never, api: api as never });

    expect(recheckChannel).toHaveBeenCalledWith(
      expect.objectContaining({ isMember: false }),
    );
  });

  it('is a no-op when there are no candidates', async () => {
    const adminClient = {
      quests: {
        channelRecheckCandidates: vi.fn().mockResolvedValue([]),
        recheckChannel: vi.fn(),
      },
    };
    const api = { getChatMember: vi.fn() };

    const stats = await runQuestChannelRecheck({ adminClient: adminClient as never, api: api as never });

    expect(api.getChatMember).not.toHaveBeenCalled();
    expect(stats).toEqual({ checked: 0, reverted: 0, skipped: 0 });
  });
});
