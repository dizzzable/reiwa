import type { TFunction } from "i18next";

import type { EligibleAddOn } from "@/lib/api-client";
import {
  countdown,
  formatZoneDate,
  formatZoneTime,
  operatorZone,
  zonePhrase,
  type Countdown,
} from "@/lib/operator-zone";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { UserAddOnEntitlement } from "@/types/api";

/** What the wording needs besides the add-on itself. */
export interface AddOnEndContext {
  /**
   * `displayTimeZone` of the same answer — the panel's «Часовой пояс».
   * `null` or absent reads as UTC, and is named so.
   */
  readonly displayTimeZone?: string | null;
  /** The interface language (`i18n.language`): the date's form and the zone's name follow it. */
  readonly language: string | undefined;
  /** «через 7 дн.» counts from here; the moment of rendering when absent. */
  readonly now?: Date;
}

/** Which bound ends the add-on, as the panel says; `undefined` from a panel that predates the field. */
type EndsBound = "reset" | "subscription_end" | null | undefined;

function instant(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function countdownText(left: Countdown, t: TFunction): string {
  switch (left.unit) {
    case "day":
      return t("addons.inDays", { count: left.count });
    case "hour":
      return t("addons.inHours", { count: left.count });
    default:
      return t("addons.inMinutes", { count: left.count });
  }
}

/**
 * The line the panel's bound calls for, or `null` when it names none this
 * cabinet can print — an older panel, or a bound without its date:
 *
 *   - `reset` — «Действует до сброса трафика 01.10 в 03:20 (по Москве) — через
 *     7 дн.». The RESET instant, not the take-off half an hour later: the
 *     customer's counter goes back to zero at the reset, and that is the
 *     moment they lose the gigabytes. «через …» only while it is ahead and
 *     `withCountdown` asks for it;
 *   - `subscription_end` — «Действует до конца подписки 20.09», from `endsAt`.
 *     A reset add-on the subscription's end cuts short is one of these, even
 *     though the panel still sends its `nextResetAt`: it ends by that date.
 *
 * Both on the operator's clock ({@link operatorZone}).
 */
function boundLine(
  bound: EndsBound,
  resetAt: string | null | undefined,
  endsAt: string | null | undefined,
  t: TFunction,
  context: AddOnEndContext,
  withCountdown: boolean,
): string | null {
  const zone = operatorZone(context.displayTimeZone);
  const now = context.now ?? new Date();
  if (bound === "reset") {
    const reset = instant(resetAt);
    if (reset === null) return null;
    const end = t("addons.untilReset", {
      date: formatZoneDate(reset, zone, context.language, now),
      time: formatZoneTime(reset, zone),
      zone: zonePhrase(zone, reset, context.language),
    });
    const left = withCountdown ? countdown(reset, now, zone) : null;
    return left === null ? end : t("addons.endCountdown", { end, countdown: countdownText(left, t) });
  }
  if (bound === "subscription_end") {
    const end = instant(endsAt);
    if (end === null) return null;
    return t("addons.untilSubscriptionEndOn", { date: formatZoneDate(end, zone, context.language, now) });
  }
  return null;
}

/** An offered add-on, as far as its end is concerned. */
type OfferedAddOn = Pick<EligibleAddOn, "type" | "lifetime"> & {
  readonly eligibility?: Pick<
    EligibleAddOn["eligibility"],
    "expiresAt" | "dated" | "endsBound" | "nextResetAt" | "resetSoon"
  > | null;
};

/**
 * Until when an add-on bought NOW will work — the line under it in the list and
 * on the confirmation.
 *
 * The panel says which bound ends it (`eligibility.endsBound`), and the line
 * follows ({@link boundLine}): «Действует до сброса трафика 01.10 в 03:20 (по
 * Москве) — через 7 дн.», or «Действует до конца подписки 20.09» — on the
 * operator's clock, `context.displayTimeZone`.
 *
 * A panel that predates the bound sends none, and this cabinet ships first:
 * the line then reads as it always did, «Действует до 12.10.26» from
 * `eligibility.expiresAt` (the end of the period, or the next reset — the
 * same date the purchase is ledgered with), on the phone's clock.
 *
 * ONLY WHEN THE PANEL SAYS THE PURCHASE IS DATED (`eligibility.dated`). A panel
 * with stage 2 off — every panel up to 0.9.7.68, an install that sets it
 * `false`, a rollback — sells the add-on as a permanent increment and still
 * sends `expiresAt`, the date the grant WOULD end: said here, it promised an
 * end the purchase never has. A panel older than the field
 * sends no `dated`, and this cabinet ships first — so no field is no date.
 *
 * `null`, and no line at all:
 *   - for a purchase the panel does not say is dated, whatever date it sends;
 *   - for a traffic reset, which grants nothing that could end;
 *   - when a dated purchase carries neither a date nor a subscription-end
 *     lifetime to read one from — a line the panel cannot back would be a guess.
 * «До конца подписки» is kept for a dated purchase with no date — the panel
 * sends none today (an add-on on a subscription with no end is not dated), but
 * would for one the ledger records open-ended.
 */
export function describeAddOnEnd(addOn: OfferedAddOn, t: TFunction, context: AddOnEndContext): string | null {
  if (addOn.type === "RESET_TRAFFIC") return null;
  const eligibility = addOn.eligibility;
  if (eligibility?.dated !== true) return null;
  const bound = boundLine(eligibility.endsBound, eligibility.nextResetAt, eligibility.expiresAt, t, context, true);
  if (bound !== null) return bound;
  const expiresAt = eligibility.expiresAt;
  if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))) {
    return t("addons.validUntil", { date: formatDate(expiresAt) });
  }
  if (expiresAt === null && addOn.lifetime === "UNTIL_SUBSCRIPTION_END") {
    return t("addons.untilSubscriptionEnd");
  }
  return null;
}

/**
 * «Сброс трафика через 5 ч — после него опция закончится» — said before the
 * payment when the reset that ends this add-on is less than a day away. A
 * purchase that close to a reset is sold at the full price (the owner,
 * 24.09.2026), so the customer is told plainly instead.
 *
 * The panel decides it (`eligibility.resetSoon`, only for the `reset` bound).
 * Nothing when it does not say so — an older panel never does — nor for a
 * purchase it does not date, which no reset ends; nor once the reset has
 * passed while the offer sat on the screen: a purchase made now belongs to
 * the next cycle, which the panel quotes afresh.
 */
export function describeResetSoon(addOn: OfferedAddOn, t: TFunction, context: AddOnEndContext): string | null {
  const eligibility = addOn.eligibility;
  if (eligibility?.dated !== true) return null;
  if (eligibility.resetSoon !== true || eligibility.endsBound !== "reset") return null;
  const reset = instant(eligibility.nextResetAt);
  if (reset === null) return null;
  const left = countdown(reset, context.now ?? new Date(), operatorZone(context.displayTimeZone));
  return left === null ? null : t("addons.resetSoonWarning", { countdown: countdownText(left, t) });
}

/** States in which an add-on works, or is about to: only these count down to their end. */
const LIVE_STATES: ReadonlySet<string> = new Set(["ACTIVE", "EXPIRING", "PENDING_ACTIVATION"]);

/**
 * An add-on with no date that still works — or will, once its period begins —
 * and ends with the subscription: one bought "until the end" of a subscription
 * that has no end date. Said so rather than left blank beside its dated
 * neighbours. A cancelled or finished one with no date says nothing: it ended
 * already, and "until the subscription ends" would be untrue.
 */
function endsWithSubscription(entitlement: Pick<UserAddOnEntitlement, "lifetime" | "state">): boolean {
  return (
    entitlement.lifetime === "UNTIL_SUBSCRIPTION_END" &&
    (entitlement.state === "ACTIVE" || entitlement.state === "PENDING_ACTIVATION")
  );
}

/**
 * The end of a bought add-on in «Мои опции», in the offer's forms: the reset
 * (`resetAt`) or the subscription's end (`expiresAt`), as `endsBound` says —
 * «через …» only for one that still works, since a finished one has nothing
 * left to count down to.
 *
 * A panel that predates `endsBound` keeps the old wording: «Действует до 23
 * окт, 14:30» on the phone's clock, or «До конца подписки» for a live one with
 * no date.
 */
export function describeEntitlementEnd(
  entitlement: Pick<UserAddOnEntitlement, "lifetime" | "state" | "expiresAt" | "endsBound" | "resetAt">,
  t: TFunction,
  context: AddOnEndContext,
): string | null {
  const live = LIVE_STATES.has(entitlement.state);
  const bound = boundLine(entitlement.endsBound, entitlement.resetAt, entitlement.expiresAt, t, context, live);
  if (bound !== null) return bound;
  if (entitlement.expiresAt) {
    return t("addonsHistory.expires", { date: formatDateTime(entitlement.expiresAt) });
  }
  return endsWithSubscription(entitlement) ? t("addons.untilSubscriptionEnd") : null;
}
