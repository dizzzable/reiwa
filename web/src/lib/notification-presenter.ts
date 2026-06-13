/**
 * notification-presenter
 * ───────────────────────
 * The rezeis edge returns notification events as `{ type, payload, readAt }`.
 * The human-readable title/body are derived (and localized) here so the
 * cabinet feed and the Activity page render consistent text for every
 * notification type — including broadcasts, whose body lives in
 * `payload.text` (and may contain Telegram-style HTML that we strip for the
 * plain-text feed).
 */
import type { TFunction } from "i18next";

import type { PresentedNotification, UserNotification } from "@/types/api";

/** Strip simple HTML tags + collapse whitespace for plain-text feed display. */
function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function presentNotification(
  n: UserNotification,
  t: TFunction,
): PresentedNotification {
  const payload = (n.payload ?? {}) as Record<string, unknown>;
  const rawBody =
    readString(payload.text) ??
    readString(payload.message) ??
    readString(payload.body) ??
    "";
  const body = stripHtml(rawBody);

  let title: string;
  switch (n.type) {
    case "broadcast":
      title = t("notifications.types.broadcast");
      break;
    case "ADMIN_MESSAGE":
      title = t("notifications.types.adminMessage");
      break;
    default:
      // Prefer an explicit payload title, else a generic label.
      title = readString(payload.title) ?? t("notifications.types.generic");
      break;
  }

  return {
    id: n.id,
    type: n.type,
    title,
    body,
    isRead: n.readAt != null,
    createdAt: n.createdAt,
  };
}
