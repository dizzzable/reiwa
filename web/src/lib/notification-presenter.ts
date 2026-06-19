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
  let resolvedBody = body;
  switch (n.type) {
    case "broadcast":
      // Operator-set broadcast title when present, else a generic label.
      title = readString(payload.title) ?? t("notifications.types.broadcast");
      break;
    case "ADMIN_MESSAGE":
      title = readString(payload.title) ?? t("notifications.types.adminMessage");
      break;
    case "expires_in_3_days":
    case "expires_in_1_days":
      // Expiry reminders carry no `text` — synthesise a friendly title/body
      // from the payload (`daysLeft`, `planName`) so the cabinet feed reads
      // like a real notification instead of a blank "generic" row.
      title = t("notifications.types.expiry");
      resolvedBody = body || presentExpiryBody(payload, t);
      break;
    default:
      // Subscription-expiry aliases + everything else.
      if (n.type.toLowerCase().includes("expir")) {
        title = t("notifications.types.expiry");
        resolvedBody = body || presentExpiryBody(payload, t);
      } else {
        // Prefer an explicit payload title, else a generic label.
        title = readString(payload.title) ?? t("notifications.types.generic");
      }
      break;
  }

  return {
    id: n.id,
    type: n.type,
    title,
    body: resolvedBody,
    isRead: n.readAt != null,
    createdAt: n.createdAt,
  };
}

/** Build a localized expiry-reminder body from the notification payload. */
function presentExpiryBody(payload: Record<string, unknown>, t: TFunction): string {
  const days =
    typeof payload.daysLeft === "number" && Number.isFinite(payload.daysLeft)
      ? Math.max(0, Math.round(payload.daysLeft))
      : null;
  const planName = readString(payload.planName) ?? readString(payload.plan);
  const plan = planName ? `«${planName}» ` : "";
  return days != null
    ? t("notifications.expiryBody", { count: days, plan })
    : t("notifications.expiryBodyGeneric", { plan });
}
