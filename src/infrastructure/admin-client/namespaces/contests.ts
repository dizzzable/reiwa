/**
 * Contests namespace — the events with a draw at the end, as the person
 * entering them sees them: what is running, whether they are in, how they
 * did, and who won a finished one (names masked). Scoped to the session's
 * identity throughout; who else entered never comes down this path.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class ContestsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Running contests, this person's results, and — `results=all` — every
   * contest drawn lately with its masked winners. Without the flag a panel
   * keeps to what an older cabinet can draw; a panel older than the flag
   * ignores it.
   */
  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/contests/${encodeURIComponent(reference(identity))}?results=all`,
    );
  }

  /**
   * Enter. Answered, not thrown, when refused — the reason is shown inline.
   *
   * `channelMember` is what Telegram said about the contest's channel, on the
   * second call the panel asks for; absent on the first.
   */
  enter(identity: UserIdentity, contestId: string, channelMember?: boolean | null): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/contests/${encodeURIComponent(reference(identity))}/${encodeURIComponent(contestId)}/enter`,
      channelMember === undefined ? {} : { channelMember },
    );
  }
}
