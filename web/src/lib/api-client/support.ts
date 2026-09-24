/**
 * Support tickets namespace.
 */
import { collectDeviceSignals } from "@/lib/device-signals";
import { configVersionRequest } from "@/lib/config-versions";
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
  /**
   * Set once an operator has reclaimed the disk. The row survives so the
   * thread can still say what was sent and when; the bytes do not, and the
   * stream answers 404 — so the chip must not be a link.
   */
  purgedAt?: string | null;
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

/**
 * Attach a file to one of your own tickets.
 *
 * Base64 in JSON, matching the transport the panel already speaks. The server
 * re-validates the decoded bytes — the declared type here is advisory and
 * carries no weight.
 */
export const attachToTicket = (
  ticketId: string,
  file: { filename: string; mimeType: string; dataBase64: string; content?: string },
) =>
  apiClient
    .post<SupportTicket>(`/support/tickets/${ticketId}/attachments`, file)
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

/** With the version the cabinet holds once it is known (`?v=`, `lib/config-versions.ts`). */
export const getGuestSupportConfig = () => {
  const versioned = configVersionRequest("guestSupport");
  return (
    versioned === undefined
      ? apiClient.get<{ enabled: boolean; turnstileSiteKey: string | null }>("/support/guest/config")
      : apiClient.get<{ enabled: boolean; turnstileSiteKey: string | null }>("/support/guest/config", versioned)
  ).then((r) => r.data);
};

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
/**
 * The guest page's language, sent with the message that opens a conversation
 * and with each reply: the panel writes the guest's reply letters in it (a
 * guest has no account to read it from). Anything but `ru`/`en` is not sent.
 */
export type GuestPageLocale = "ru" | "en";

/** The page's i18next language as the one a letter can be written in; `undefined` for any other. */
export function guestPageLocale(language: string | undefined): GuestPageLocale | undefined {
  const head = (language ?? "").toLowerCase().split(/[-_]/, 1)[0];
  return head === "ru" || head === "en" ? head : undefined;
}

export const createGuestTicket = async (input: {
  subject: string;
  message: string;
  email?: string;
  captchaToken?: string;
  locale?: GuestPageLocale;
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

/**
 * What following a way in did (`POST /support/guest/resume` in the BFF):
 * `opened` — this device now holds the conversation; `continued` — it already
 * did; `stale` — the link is out of date, `ticket` being the conversation the
 * device already holds, if any; `confirm` — the device holds another open
 * conversation, and switching needs the visitor's word (`confirm: true`).
 */
export type GuestResumeResult =
  | { readonly status: "opened" | "continued"; readonly ticket: GuestTicket }
  | { readonly status: "stale"; readonly ticket: GuestTicket | null }
  | {
      readonly status: "confirm";
      readonly opening: { readonly subject: string };
      readonly current: { readonly subject: string };
    };

export const resumeGuestConversation = (resume: string, confirm = false) =>
  apiClient
    .post<GuestResumeResult>("/support/guest/resume", confirm ? { resume, confirm: true } : { resume })
    .then((r) => r.data);

export const replyGuestConversation = (content: string, resume?: string, locale?: GuestPageLocale) =>
  apiClient
    .post<GuestTicket>("/support/guest/reply", {
      content,
      ...(resume ? { resume } : {}),
      ...(locale ? { locale } : {}),
    })
    .then((r) => r.data);

export const closeGuestConversation = (resume?: string) =>
  apiClient
    .post<{ ok: true }>("/support/guest/close", resume ? { resume } : {})
    .then((r) => r.data);
