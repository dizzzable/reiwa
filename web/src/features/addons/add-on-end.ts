import type { TFunction } from "i18next";

import type { EligibleAddOn } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";

/**
 * Until when an add-on bought NOW will work — the line under it in the list and
 * on the confirmation: «Действует до 12.10.26».
 *
 * The date is the panel's (`eligibility.expiresAt`): the end of the current
 * period for "until the end of the subscription", the next traffic reset for
 * "until the next reset" — the same date the purchase is then ledgered with.
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
export function describeAddOnEnd(
  addOn: Pick<EligibleAddOn, "type" | "lifetime"> & {
    readonly eligibility?: Pick<EligibleAddOn["eligibility"], "expiresAt" | "dated"> | null;
  },
  t: TFunction,
): string | null {
  if (addOn.type === "RESET_TRAFFIC") return null;
  if (addOn.eligibility?.dated !== true) return null;
  const expiresAt = addOn.eligibility.expiresAt;
  if (typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt))) {
    return t("addons.validUntil", { date: formatDate(expiresAt) });
  }
  if (expiresAt === null && addOn.lifetime === "UNTIL_SUBSCRIPTION_END") {
    return t("addons.untilSubscriptionEnd");
  }
  return null;
}
