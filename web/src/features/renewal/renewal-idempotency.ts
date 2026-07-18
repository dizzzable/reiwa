export type RenewalCheckoutDraft = {
  readonly subscriptionIds: readonly (string | number)[];
  readonly gatewayType: string;
  readonly quote: { readonly amount: string; readonly currency: string };
  readonly durations: readonly { readonly subscriptionId: string; readonly days: number }[];
  readonly plans: readonly { readonly subscriptionId: string; readonly planId: string }[];
  readonly addOns: readonly { readonly subscriptionId: string; readonly addOnIds: readonly string[] }[];
  /** Local SavedPaymentMethod.id for off-session charge, if any. */
  readonly savedPaymentMethodId?: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic draft fingerprint; retries/remounts reuse the same key. */
export function createRenewalIdempotencyKey(draft: RenewalCheckoutDraft, attemptId: string): string {
  const payload = stableJson({
    ...draft,
    attemptId,
    subscriptionIds: [...draft.subscriptionIds].map(String),
    savedPaymentMethodId: draft.savedPaymentMethodId ?? null,
  });
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `renewal-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
