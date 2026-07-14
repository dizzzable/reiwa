export interface RenewalReofferHistoryEntry {
  readonly subscriptionId: string;
  readonly addOnId: string | null;
  readonly type: "EXTRA_TRAFFIC" | "EXTRA_DEVICES";
  readonly valuePerUnit: number;
  readonly state: string;
  readonly expiresAt: string | null;
}

export interface RenewalReofferEligibleAddOn {
  readonly id: string;
  readonly type: "EXTRA_TRAFFIC" | "EXTRA_DEVICES";
  readonly value: number;
  readonly prices: readonly { readonly currency: string }[];
}

/**
 * Intersects the user's live entitlement history with the current authoritative
 * catalog for one renewal line. Missing inputs, malformed expiry timestamps and
 * missing gateway-currency prices all fail closed: renewal continues without an
 * add-on re-offer rather than presenting a stale or unpriceable paid good.
 */
export function selectRenewalReoffer<T extends RenewalReofferEligibleAddOn>(input: {
  readonly subscriptionId: string;
  readonly currency: string | null;
  readonly history: readonly RenewalReofferHistoryEntry[] | null;
  readonly eligibleAddOns: readonly T[] | null;
  readonly now?: Date;
}): readonly T[] {
  if (input.currency === null || input.history === null || input.eligibleAddOns === null) {
    return [];
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) return [];

  const liveHistory = input.history.filter((entry) => {
    if (entry.subscriptionId !== input.subscriptionId) return false;
    if (entry.state !== "ACTIVE" && entry.state !== "EXPIRING") return false;
    if (entry.expiresAt === null) return true;
    const expiresAtMs = Date.parse(entry.expiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
  });

  return input.eligibleAddOns.filter(
    (addOn) =>
      addOn.prices.some((price) => price.currency === input.currency) &&
      liveHistory.some((entry) =>
        entry.addOnId === null
          ? entry.type === addOn.type && entry.valuePerUnit === addOn.value
          : entry.addOnId === addOn.id,
      ),
  );
}
