/**
 * Quests namespace — the cabinet gamification surface. Lists the quests
 * relevant to a user (+ their points balance), claims a completed quest's
 * reward, and streams sanitized quest icon SVGs.
 *
 * User-scoped calls are templated on a `:userRef` the upstream controller
 * resolves polymorphically (reiwa_id CUID or telegramId); icon serving is
 * identity-agnostic (public sanitized assets).
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

export class QuestsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /** Quests relevant to the user + points balance. */
  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/quests/${encodeURIComponent(reference(identity))}`,
    );
  }

  /** Claim a completed quest and receive its reward. */
  claim(identity: UserIdentity, questId: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/quests/${encodeURIComponent(reference(identity))}/${encodeURIComponent(questId)}/claim`,
      {},
    );
  }

  /** Open a binary stream for a sanitized quest icon SVG. */
  downloadIcon(iconId: string): Promise<{
    status: number;
    contentType: string | null;
    contentLength: number | null;
    body: NodeJS.ReadableStream;
  } | null> {
    return this.transport.fetchBinary(
      `/api/internal/quests/icons/${encodeURIComponent(iconId)}`,
    );
  }
}
