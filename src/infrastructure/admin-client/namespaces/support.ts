/**
 * Support tickets namespace — list / fetch one / create / reply.
 *
 * The upstream `InternalUserSupportController` resolves the path
 * reference (`:userRef`) to the canonical reiwa_id — it accepts either a
 * reiwa_id (CUID, web / web-first users) or a numeric telegramId. Callers
 * pass a `UserIdentity` and we forward the best available reference so the
 * admin side can scope authorisation per request. Web-first users (no
 * Telegram) are therefore fully supported.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface CreateTicketInput {
  readonly subject: string;
  readonly message: string;
}

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class SupportNamespace {
  constructor(private readonly transport: AdminTransport) {}

  list(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/tickets`,
    );
  }

  get(identity: UserIdentity, ticketId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/tickets/${encodeURIComponent(ticketId)}`,
    );
  }

  create(identity: UserIdentity, data: CreateTicketInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/tickets`,
      data,
    );
  }

  reply(identity: UserIdentity, ticketId: string, content: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(reference(identity))}/tickets/${encodeURIComponent(ticketId)}/reply`,
      { content },
    );
  }
}
