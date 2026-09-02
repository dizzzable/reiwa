/**
 * Contests namespace — the events with a draw at the end, as the person
 * entering them sees them: what is running, whether they are in, and how they
 * did. Scoped to the session's identity throughout; who else entered and who
 * else won never comes down this path.
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

  /** Running contests, plus drawn ones this person took part in. */
  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/contests/${encodeURIComponent(reference(identity))}`,
    );
  }

  /** Enter. Answered, not thrown, when refused — the reason is shown inline. */
  enter(identity: UserIdentity, contestId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/contests/${encodeURIComponent(reference(identity))}/${encodeURIComponent(contestId)}/enter`,
      {},
    );
  }
}
