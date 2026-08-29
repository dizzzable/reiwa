/**
 * Support tickets namespace.
 */
import { collectDeviceSignals } from "@/lib/device-signals";
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

/**
 * Opens an anonymous support conversation.
 *
 * ── Why device signals go with it ─────────────────────────────────────────
 *
 * This is the one surface with no identity at all, which is the point — it is
 * how somebody appeals a ban, or reaches us when their account is broken. It is
 * also, for the same reason, where a banned person comes back: a fresh
 * incognito window is a fresh visitor, and a captcha stops robots rather than a
 * motivated human.
 *
 * The signals let the panel tell those two apart. They do NOT refuse anybody by
 * themselves — a match only marks the conversation for an operator, and the
 * decision to silence a device stays with a person. Collected here and nowhere
 * else on this surface: only when a conversation is actually opened, never
 * while somebody is reading.
 *
 * Failing to collect them is not an error. A visitor who blocks them gets an
 * unmarked conversation, which is what any unrecognised visitor gets.
 */
export const createGuestTicket = async (input: {
  subject: string;
  message: string;
  email?: string;
  captchaToken?: string;
}) => {
  const signals = await collectDeviceSignals().catch(() => ({
    installId: null,
    deviceHash: null,
  }));
  const response = await apiClient.post<{ resumeCode: string; ticket: GuestTicket }>(
    "/support/guest",
    {
      ...input,
      installId: signals.installId ?? undefined,
      deviceHash: signals.deviceHash ?? undefined,
    },
  );
  return response.data;
};

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
