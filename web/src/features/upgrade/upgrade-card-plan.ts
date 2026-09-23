import type { UpgradePlanOption } from "@/lib/api-client/subscription";
import type { Plan } from "@/types/api";

/**
 * The catalog plan an upgrade option is drawn as, on the same `TariffCard`
 * «Тарифы» and renewal draw.
 *
 * The upgrade picker drew a bare row — name, devices, traffic — because an
 * upgrade option carries only what the flow needs: no icon, no description, no
 * prices, no card look. The catalog plan has all of it. It is cut down to the
 * terms the upgrade offers, so «от ₽…» and the number of terms on the card are
 * the upgrade's, not the catalog's — `durations` and `displayPrices` both: the
 * card prices from the first and falls back to the second when no gateway
 * prices exist. Terms are matched by id, or by length when no id matches.
 *
 * `null` — a plan the catalog does not list, or none of whose terms the
 * upgrade offers: the picker draws the bare row for it rather than a card that
 * says something the next step will not.
 */
export function upgradeCardPlan(option: UpgradePlanOption, plan: Plan | undefined): Plan | null {
  if (plan === undefined) return null;
  const offeredIds = new Set(option.durations.map((duration) => String(duration.id)));
  const byId = plan.durations.filter((duration) => offeredIds.has(String(duration.id)));
  const offeredDays = new Set(option.durations.map((duration) => duration.days));
  const durations =
    byId.length > 0 ? byId : plan.durations.filter((duration) => offeredDays.has(duration.days));
  if (durations.length === 0) return null;
  const keptDays = new Set(durations.map((duration) => duration.days));
  return {
    ...plan,
    durations,
    ...(plan.displayPrices === undefined
      ? {}
      : { displayPrices: plan.displayPrices.filter((price) => keptDays.has(price.days)) }),
  };
}
