/**
 * Support tickets namespace — list / fetch one / create / reply.
 *
 * Upstream paths are templated on `telegramId` (the user owning the
 * ticket) so the admin side can scope authorisation per request without
 * relying on a query string.
 */
import type { AdminTransport } from '../transport.js';

export interface CreateTicketInput {
  readonly subject: string;
  readonly message: string;
}

export class SupportNamespace {
  constructor(private readonly transport: AdminTransport) {}

  list(telegramId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(telegramId)}/tickets`,
    );
  }

  get(telegramId: string, ticketId: string): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/user/${encodeURIComponent(telegramId)}/tickets/${encodeURIComponent(ticketId)}`,
    );
  }

  create(telegramId: string, data: CreateTicketInput): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(telegramId)}/tickets`,
      data,
    );
  }

  reply(telegramId: string, ticketId: string, content: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/user/${encodeURIComponent(telegramId)}/tickets/${encodeURIComponent(ticketId)}/reply`,
      { content },
    );
  }
}
