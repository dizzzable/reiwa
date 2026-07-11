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

  // ── Channel (Phase B) — bot-only, signed transport ────────────────────────
  //
  // These carry ONLY the authenticated Telegram id (from the bot `ctx`) plus
  // the quest id. rezeis resolves telegramId → account server-side; the browser
  // never touches this surface.

  /** Server-derived channel metadata (chat id + join URL) for a bot callback. */
  channelTarget(input: ChannelVerifyInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/quests/channel/target',
      { telegramId: input.telegramId, questId: input.questId },
    );
  }

  /** Record a fresh positive membership proof (no reward is issued here). */
  verifyChannel(input: ChannelVerifyInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/quests/channel/verify',
      { telegramId: input.telegramId, questId: input.questId },
    );
  }

  /** Apply a bot-owned periodic membership recheck result. */
  recheckChannel(input: ChannelRecheckInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/quests/channel/recheck',
      { telegramId: input.telegramId, questId: input.questId, isMember: input.isMember },
    );
  }

  /** List bounded unclaimed channel completions the bot should re-check. */
  channelRecheckCandidates(): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/quests/channel/recheck/candidates', {});
  }

  // ── Partner (Phase C) — user-scoped, session identity only ────────────────
  //
  // manual-code / timed-visit verification. The reference is resolved from the
  // BFF session (reiwa_id or telegramId), NEVER from the browser body. The
  // postback method is not here — that is a partner→rezeis signed callback.

  /** Submit a manual partner activation code for the session user. */
  submitPartnerCode(identity: UserIdentity, questId: string, code: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/quests/partner/code', {
      userRef: reference(identity),
      questId,
      code,
    });
  }

  /** Start a server-timed partner visit; returns the landing URL to open. */
  startPartnerVisit(identity: UserIdentity, questId: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/quests/partner/visit/start', {
      userRef: reference(identity),
      questId,
    });
  }

  /** Confirm a timed partner visit once the server-side dwell has elapsed. */
  confirmPartnerVisit(identity: UserIdentity, questId: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/quests/partner/visit/complete', {
      userRef: reference(identity),
      questId,
    });
  }
}

export interface ChannelVerifyInput {
  readonly telegramId: string;
  readonly questId: string;
}

export interface ChannelRecheckInput extends ChannelVerifyInput {
  readonly isMember: boolean;
}
