/**
 * The end of a subscription as the card on «Главная» prints it: «Осталось 7
 * дней — до 01.10.26».
 *
 * Both on ONE calendar — the operator's «Часовой пояс» once the panel has said
 * it (`useOperatorTimeZone`), the phone's own until then:
 *  - the date: it used to be the phone's, so near midnight the card named
 *    another day than the bot's notice about the same end (the owner's rule:
 *    a customer's dates are read on the operator's clock);
 *  - the time left: it used to be elapsed time rounded up (`getDaysLeft`), so
 *    with a day and an hour to go the card read «2 дня — до <tomorrow>». Now
 *    days on that calendar from a day away, as a person counts them against
 *    the date beside them; under a day, whole hours; under an hour, minutes
 *    (`countdown`, as the add-on lines count).
 */
import { countdown, phoneZone, type Countdown } from "@/lib/operator-zone";
import { formatDate } from "@/lib/utils";

export interface SubscriptionCardEnd {
  /** What is left — `{ unit: "day", count: 0 }` once the end has passed. */
  readonly left: Countdown;
  /** «01.10.26» — the end, on the same calendar. */
  readonly date: string;
  /** The accent: `danger` under four days (and any hours), `warning` under eight, else none. */
  readonly urgency: "danger" | "warning" | null;
}

/**
 * `null` for a subscription with no end (or one that cannot be read). `zone`:
 * the operator's, or `undefined` for the phone's calendar — `phone`, which is
 * this browser's own and is passed in only by tests.
 */
export function subscriptionCardEnd(
  expiresAt: string | null | undefined,
  zone: string | undefined,
  now: Date = new Date(),
  phone: string = phoneZone(),
): SubscriptionCardEnd | null {
  if (typeof expiresAt !== "string" || expiresAt === "") return null;
  const end = new Date(expiresAt);
  if (Number.isNaN(end.getTime())) return null;
  const calendar = zone ?? phone;
  const left: Countdown = countdown(end, now, calendar) ?? { unit: "day", count: 0 };
  const urgency = left.unit !== "day" || left.count <= 3 ? "danger" : left.count <= 7 ? "warning" : null;
  return { left, date: formatDate(end, calendar), urgency };
}
