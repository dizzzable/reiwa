/**
 * Support tickets namespace.
 */
import { apiClient } from "./transport.js";

export interface SupportTicket {
  id: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messages: SupportTicketMessage[];
}

export interface SupportAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Present on cabinet tickets; the guest serializer omits it (unused by UI). */
  createdAt?: string;
}

export interface SupportTicketMessage {
  id: string;
  authorType: string;
  authorId: string | null;
  content: string;
  createdAt: string;
  /** Files attached to this message (e.g. an operator reply's photo). */
  attachments?: SupportAttachmentMeta[];
}

/**
 * Same-origin URL for streaming a support attachment. The session cookie is
 * sent automatically (same-origin `<img>`/`<a>`), and the backend scopes the
 * fetch to the calling user's own ticket.
 */
export const supportAttachmentUrl = (ticketId: string, attachmentId: string): string =>
  `/api/v1/support/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}`;

/**
 * Same-origin URL for streaming a GUEST-conversation attachment. Scoped
 * server-side by the httpOnly guest token (no ticket id in the path), so an
 * anonymous guest only ever reaches files on their own bound conversation.
 */
export const supportGuestAttachmentUrl = (attachmentId: string): string =>
  `/api/v1/support/guest/attachments/${encodeURIComponent(attachmentId)}`;

export const getTickets = () =>
  apiClient.get<SupportTicket[]>("/support/tickets").then((r) => r.data);

export const getTicket = (ticketId: string) =>
  apiClient
    .get<SupportTicket>(`/support/tickets/${ticketId}`)
    .then((r) => r.data);

export const createTicket = (subject: string, message: string) =>
  apiClient
    .post<SupportTicket>("/support/tickets", { subject, message })
    .then((r) => r.data);

export const replyToTicket = (ticketId: string, content: string) =>
  apiClient
    .post<SupportTicketMessage>(`/support/tickets/${ticketId}/reply`, { content })
    .then((r) => r.data);

// ── Anonymous guest conversations ──────────────────────────────────────────
// Public, session-less. The server-bound guest token rides in an httpOnly
// cookie; an explicit `resume` code is the fallback to restore on another
// device. The client never sends a ticket id.

export interface GuestTicket {
  id: string;
  subject: string;
  status: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    authorType: string;
    content: string;
    createdAt: string;
    /** Files attached to this message (e.g. an operator reply's photo). */
    attachments?: SupportAttachmentMeta[];
  }>;
}

export const getGuestSupportConfig = () =>
  apiClient
    .get<{ enabled: boolean; turnstileSiteKey: string | null }>("/support/guest/config")
    .then((r) => r.data);

export const createGuestTicket = (input: {
  subject: string;
  message: string;
  email?: string;
  captchaToken?: string;
}) =>
  apiClient
    .post<{ resumeCode: string; ticket: GuestTicket }>("/support/guest", input)
    .then((r) => r.data);

export const getGuestConversation = (resume?: string) =>
  apiClient
    .get<GuestTicket>("/support/guest", resume ? { params: { resume } } : undefined)
    .then((r) => r.data);

export const replyGuestConversation = (content: string, resume?: string) =>
  apiClient
    .post<GuestTicket>("/support/guest/reply", { content, ...(resume ? { resume } : {}) })
    .then((r) => r.data);

export const closeGuestConversation = (resume?: string) =>
  apiClient
    .post<{ ok: true }>("/support/guest/close", resume ? { resume } : {})
    .then((r) => r.data);
