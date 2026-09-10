import type { TFunction } from "i18next";

/**
 * realtime-event-copy
 * ───────────────────
 * What a live event says to the customer, in the customer's own language.
 *
 * ── Why the event's own message is not it ────────────────────────────────────
 *
 * The panel forwards `projection.message ?? event.message`, and until the
 * projection required a message that fell through to the OPERATOR'S sentence —
 * written for an operator's feed, in English, naming things a customer has no
 * business reading: the Remnawave profile the operator's naming scheme built
 * around their login, the words "BLOCKED customer", an internal queue failure
 * with its reason. Those toasts were shown to customers.
 *
 * The panel now sends a neutral sentence instead, so nothing leaks even to a
 * cabinet that predates this file. But it is one language, and this cabinet is
 * two — so the type is what the copy hangs off here, and the server's string is
 * the fallback for a type this build has not heard of.
 *
 * ── Fall back, never blank ───────────────────────────────────────────────────
 *
 * A type with no entry falls through to what the server sent. Showing nothing
 * would drop a notification the customer was meant to get, and showing the raw
 * key would be worse than the English sentence it replaced.
 */

/** Types this cabinet has its own words for. The panel's whitelist, mirrored. */
const KNOWN = [
  "subscription.created",
  "subscription.renewed",
  "subscription.expired",
  "subscription.deleted",
  "subscription.upgraded",
  "user_hwid_revoked",
  "payment.completed",
  "payment.failed",
  "promocode.activated",
  "referral.qualified",
  "referral.reward_issued",
  "user.deleted",
  // Reaches this cabinet through `userRealtimeQueryKeysByType` even though the
  // panel no longer broadcasts it — an older panel might, and a type that is
  // registered but unnamed here falls through to the panel's own sentence.
  // `realtime-event-copy.test.ts` pins this list against that registry.
  "subscription.trial_granted",
] as const;

const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN);

export function realtimeEventText(
  t: TFunction,
  event: { readonly type: string; readonly message: string },
): string {
  if (!KNOWN_SET.has(event.type)) return event.message;
  // The dotted type IS the key's tail, so adding a type on the panel and here
  // is one edit in each — and `realtime-event-copy.test.ts` checks that every
  // name above resolves to something rather than to the key itself.
  const text = t(`realtimeEvents.${event.type}`);
  return text === `realtimeEvents.${event.type}` ? event.message : text;
}

export const REALTIME_EVENT_TYPES = KNOWN;
