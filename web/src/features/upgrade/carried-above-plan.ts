import type { TFunction } from "i18next";

import type { UpgradePlanOption } from "@/lib/api-client/subscription";
import type { CarriedAbovePlan } from "@/types/api";

/**
 * The one line the upgrade review adds when the subscription keeps something
 * above the new plan: «Сверх тарифа: +2 устройства, +10 ГБ — это сохранится и
 * на новом тарифе.»
 *
 * What sits above the plan is not always bought — an operator's raise and a
 * bonus carry exactly as a paid add-on does — so the wording names none of
 * them, only the amounts.
 *
 * `null`, and no line at all, when:
 *   - the quote carries no `carriedAbovePlan` — nothing carries, or the panel
 *     is older than the field (the cabinet ships first);
 *   - the only thing that carries is on a resource the new plan leaves
 *     unlimited. The panel already sends nothing there; the target is checked
 *     here as well, so a line can never add "+2 devices" to unlimited ones.
 */
export function describeCarriedAbovePlan(
  carried: CarriedAbovePlan | undefined,
  target: Pick<UpgradePlanOption, "trafficLimit" | "deviceLimit"> | null,
  t: TFunction,
): string | null {
  if (carried === undefined) return null;
  const items: string[] = [];
  if (target === null || target.deviceLimit > 0) {
    if (carried.unlimitedDevices) items.push(t("upgrade.aboveUnlimitedDevices"));
    else if (carried.deviceLimit > 0) items.push(t("upgrade.aboveDevices", { count: carried.deviceLimit }));
  }
  if (target === null || target.trafficLimit !== null) {
    if (carried.unlimitedTraffic) items.push(t("upgrade.aboveUnlimitedTraffic"));
    else if (carried.trafficLimitGb > 0) items.push(t("upgrade.aboveTraffic", { value: carried.trafficLimitGb }));
  }
  return items.length === 0 ? null : t("upgrade.keepsAbovePlan", { items: items.join(", ") });
}
