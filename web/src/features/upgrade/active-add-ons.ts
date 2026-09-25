import type { TFunction } from "i18next";

import type { UpgradePlanOption } from "@/lib/api-client/subscription";
import { formatDate } from "@/lib/utils";
import type { ActiveAddOnKept } from "@/types/api";

/**
 * The line the upgrade review adds for the live add-ons the subscription
 * keeps: «Опции останутся: +2 устройства — до 12.10.26; +50 ГБ — до 01.11.26.»
 *
 * Each keeps its own end date, never later than the subscription's new end
 * (owner, 24.09.2026); the date shown is the one the panel worked out by that
 * rule. They are NOT in «Сверх тарифа» — the panel takes them out of
 * `carriedAbovePlan` — so nothing is named twice: «Сверх тарифа» is what stays
 * for good, this line is what stays until a date.
 *
 * `null`, and no line at all, when:
 *   - the quote carries no `activeAddOns` — none are live, or the panel is
 *     older than the field (the cabinet ships first);
 *   - the only ones left are on a resource the new plan leaves unlimited. The
 *     panel already sends nothing there; the target is checked here as well,
 *     as `describeCarriedAbovePlan` checks it.
 */
export function describeActiveAddOns(
  addOns: readonly ActiveAddOnKept[] | undefined,
  target: Pick<UpgradePlanOption, "trafficLimit" | "deviceLimit"> | null,
  t: TFunction,
  /** The calendar the dates are read on — the operator's (`useOperatorTimeZone`); the phone's when omitted. */
  timeZone?: string,
): string | null {
  if (addOns === undefined) return null;
  const items = addOns.flatMap((addOn): string[] => {
    const isTraffic = addOn.type === "EXTRA_TRAFFIC";
    if (target !== null && (isTraffic ? target.trafficLimit === null : target.deviceLimit <= 0)) return [];
    const item = isTraffic
      ? t("upgrade.aboveTraffic", { value: addOn.value })
      : t("upgrade.aboveDevices", { count: addOn.value });
    return [
      addOn.expiresAt === null
        ? t("upgrade.addOnUntilEnd", { item })
        : t("upgrade.addOnUntil", { item, date: formatDate(addOn.expiresAt, timeZone) }),
    ];
  });
  return items.length === 0 ? null : t("upgrade.keepsAddOns", { items: items.join("; ") });
}
