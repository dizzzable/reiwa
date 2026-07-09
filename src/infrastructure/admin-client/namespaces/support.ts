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

  /**
   * Open a binary stream for an attachment on one of the user's OWN tickets.
   * Upstream re-checks the ticket belongs to the resolved user, so a user can
   * never read another user's file. Returns `null` on 404/permission failure.
   */
  downloadAttachment(
    identity: UserIdentity,
    ticketId: string,
    attachmentId: string,
  ): Promise<{
    status: number;
    contentType: string | null;
    contentLength: number | null;
    body: NodeJS.ReadableStream;
  } | null> {
    return this.transport.fetchBinary(
      `/api/internal/user/${encodeURIComponent(reference(identity))}/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  // ── Anonymous (guest) conversations ────────────────────────────────────────
  // Authorization is bound server-side to the raw token relayed in the
  // `x-support-guest-token` header; rezeis resolves it by hash. The token is
  // never placed in the path/body, and the client never asserts a ticket id.

  createGuest(input: {
    readonly subject: string;
    readonly message: string;
    readonly email?: string | null;
    readonly clientIp?: string | null;
  }): Promise<GuestTicketResponse> {
    const headers: Record<string, string> = {};
    if (input.clientIp) headers['x-support-client-ip'] = input.clientIp;
    return this.transport.request<GuestTicketResponse>(
      'POST',
      '/api/internal/support/guest',
      { subject: input.subject, message: input.message, email: input.email ?? undefined },
      headers,
    );
  }

  getGuest(token: string): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/support/guest', undefined, {
      'x-support-guest-token': token,
    });
  }

  replyGuest(token: string, content: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/support/guest/reply', { content }, {
      'x-support-guest-token': token,
    });
  }

  closeGuest(token: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/support/guest/close', {}, {
      'x-support-guest-token': token,
    });
  }

  /** Attach a guest conversation (bound to `token`) to a logged-in account. */
  attachGuest(token: string, userRef: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/support/guest/attach', { userRef }, {
      'x-support-guest-token': token,
    });
  }

  /**
   * Panel-managed runtime config for the public edge: the master enabled
   * flag, the public Turnstile site key, and the secret used for captcha
   * verification. Fetched (and cached) by the guest router instead of env.
   */
  getRuntimeConfig(): Promise<GuestRuntimeConfig> {
    return this.transport.request<GuestRuntimeConfig>('GET', '/api/internal/support/guest/config');
  }

  /** Relay a base64 attachment upload for the bound guest conversation. */
  uploadGuestAttachment(token: string, input: GuestAttachmentUpload): Promise<unknown> {
    return this.transport.request(
      'POST',
      '/api/internal/support/guest/attachments',
      {
        filename: input.filename,
        mimeType: input.mimeType,
        content: input.content,
        dataBase64: input.dataBase64,
      },
      { 'x-support-guest-token': token },
    );
  }

  /** Open a binary stream for an attachment on the bound guest conversation. */
  downloadGuestAttachment(
    token: string,
    attachmentId: string,
  ): Promise<{
    status: number;
    contentType: string | null;
    contentLength: number | null;
    body: NodeJS.ReadableStream;
  } | null> {
    return this.transport.fetchBinary(
      `/api/internal/support/guest/attachments/${encodeURIComponent(attachmentId)}`,
      { 'x-support-guest-token': token },
    );
  }
}

export interface GuestAttachmentUpload {
  readonly filename: string;
  readonly mimeType?: string;
  readonly content?: string;
  readonly dataBase64: string;
}

export interface GuestTicketResponse {
  readonly token: string;
  readonly resumeCode: string;
  readonly ticket: unknown;
}

export interface GuestRuntimeConfig {
  readonly enabled: boolean;
  readonly turnstileSiteKey: string;
  readonly turnstileSecret: string | null;
}
