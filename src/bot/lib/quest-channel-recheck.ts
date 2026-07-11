/**
 * Bot-owned periodic channel-membership recheck.
 *
 * rezeis owns quest completion state but has no Telegram token, so this loop
 * runs inside the bot process: pull a bounded set of unclaimed channel
 * completions, probe live membership with the bot's own `getChatMember`, and
 * report each definite result back to rezeis. A negative result reverts an
 * unclaimed completion (blocking the reward until re-subscribed); a Telegram
 * error is skipped and retried next tick — it is NEVER reported, so a transient
 * outage can neither fabricate a positive nor wrongly revoke a completion.
 */
import type { AdminClient } from '../../infrastructure/admin-client/index.js';
import { isSubscribedMember, type ChatMemberLike } from './chat-membership.js';

interface RecheckCandidate {
  readonly questId: string;
  readonly telegramId: string;
  readonly chatId: string;
  readonly joinUrl: string;
}

interface BotApiLike {
  getChatMember(chatId: string | number, userId: number): Promise<ChatMemberLike>;
}

export interface QuestChannelRecheckStats {
  readonly checked: number;
  readonly reverted: number;
  readonly skipped: number;
}

export async function runQuestChannelRecheck(deps: {
  readonly adminClient: AdminClient;
  readonly api: BotApiLike;
  readonly logger?: { warn: (obj: unknown, msg: string) => void };
}): Promise<QuestChannelRecheckStats> {
  const candidates = (await deps.adminClient.quests.channelRecheckCandidates()) as
    | readonly RecheckCandidate[]
    | null;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { checked: 0, reverted: 0, skipped: 0 };
  }

  let checked = 0;
  let reverted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const telegramId = Number(candidate.telegramId);
    if (!Number.isSafeInteger(telegramId)) {
      skipped += 1;
      continue;
    }
    let member: ChatMemberLike;
    try {
      member = await deps.api.getChatMember(candidate.chatId, telegramId);
    } catch (err: unknown) {
      // FAIL-SAFE: a Telegram error is inconclusive — leave state untouched.
      skipped += 1;
      deps.logger?.warn(
        { err, telegramId: candidate.telegramId, questId: candidate.questId },
        'quest-channel recheck: getChatMember failed (skipped)',
      );
      continue;
    }

    const isMember = isSubscribedMember(member);
    try {
      await deps.adminClient.quests.recheckChannel({
        telegramId: candidate.telegramId,
        questId: candidate.questId,
        isMember,
      });
      checked += 1;
      if (!isMember) reverted += 1;
    } catch (err: unknown) {
      skipped += 1;
      deps.logger?.warn(
        { err, telegramId: candidate.telegramId, questId: candidate.questId },
        'quest-channel recheck: report failed',
      );
    }
  }

  return { checked, reverted, skipped };
}
