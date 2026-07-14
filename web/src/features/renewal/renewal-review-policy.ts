const CURRENCY_SCALE_DIGITS = 8;
const CURRENCY_SCALE = 100_000_000n;
const MAX_CURRENCY_SCALED = 10n ** 20n - 1n;

function parseCurrencyAmount(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(CURRENCY_SCALE_DIGITS, '0');
  const scaled = BigInt(match[1]!) * CURRENCY_SCALE + BigInt(fraction || '0');
  return scaled <= MAX_CURRENCY_SCALED ? scaled : null;
}

function serializeCurrencyAmount(scaled: bigint): string {
  const whole = scaled / CURRENCY_SCALE;
  const fraction = (scaled % CURRENCY_SCALE)
    .toString()
    .padStart(CURRENCY_SCALE_DIGITS, '0')
    .replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/** Exact non-negative Decimal(20,8) addition for review/payment quote pins. */
export function addCurrencyAmounts(amounts: readonly string[]): string | null {
  let total = 0n;
  for (const amount of amounts) {
    const parsed = parseCurrencyAmount(amount);
    if (parsed === null) return null;
    total += parsed;
    if (total > MAX_CURRENCY_SCALED) return null;
  }
  return serializeCurrencyAmount(total);
}

/** Displays at least cents while retaining all significant crypto precision. */
export function formatCurrencyAmount(amount: string): string {
  const parsed = parseCurrencyAmount(amount);
  if (parsed === null) return amount;
  const canonical = serializeCurrencyAmount(parsed);
  const [whole, fraction = ''] = canonical.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export interface RenewalReviewEligibleAddOn {
  readonly id: string;
  readonly prices: readonly {
    readonly currency: string;
    readonly price: string;
  }[];
}

export interface RenewalReviewEligibilityQuery<T extends RenewalReviewEligibleAddOn> {
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly data?: {
    readonly availability: string;
    readonly addOns: readonly T[];
  };
}

export interface RenewalReviewAddOnLine<T extends RenewalReviewEligibleAddOn> {
  readonly subscriptionId: string;
  readonly addOn: T;
  readonly price: string;
}

export interface RenewalAddOnReviewResult<T extends RenewalReviewEligibleAddOn> {
  readonly status: 'PENDING' | 'ERROR' | 'READY';
  readonly lines: readonly RenewalReviewAddOnLine<T>[];
  readonly addOnTotal: string;
  readonly allowsPartnerBalance: boolean;
}

/**
 * Resolves selected renewal add-ons against settled, authoritative eligibility.
 * Any unresolved selection fails closed so review cannot show or submit a total
 * that silently omits a selected paid line.
 */
export function resolveRenewalAddOnReview<T extends RenewalReviewEligibleAddOn>(input: {
  readonly selectedSubscriptionIds: readonly string[];
  readonly selectedAddOns: Readonly<Record<string, readonly string[]>>;
  readonly currency: string | null;
  readonly eligibilityQueries: readonly RenewalReviewEligibilityQuery<T>[];
}): RenewalAddOnReviewResult<T> {
  const selectionCount = input.selectedSubscriptionIds.reduce(
    (count, subscriptionId) => count + (input.selectedAddOns[subscriptionId]?.length ?? 0),
    0,
  );
  if (selectionCount === 0) {
    return { status: 'READY', lines: [], addOnTotal: '0', allowsPartnerBalance: true };
  }
  if (input.currency === null) {
    return { status: 'ERROR', lines: [], addOnTotal: '0', allowsPartnerBalance: false };
  }

  const requiredQueries = input.selectedSubscriptionIds
    .map((subscriptionId, index) => ({
      subscriptionId,
      selectedIds: input.selectedAddOns[subscriptionId] ?? [],
      query: input.eligibilityQueries[index],
    }))
    .filter(({ selectedIds }) => selectedIds.length > 0);

  if (requiredQueries.some(({ query }) => !query || query.isLoading || query.isFetching)) {
    return { status: 'PENDING', lines: [], addOnTotal: '0', allowsPartnerBalance: false };
  }
  if (
    requiredQueries.some(
      ({ query }) => query!.isError || query!.data?.availability !== 'AVAILABLE',
    )
  ) {
    return { status: 'ERROR', lines: [], addOnTotal: '0', allowsPartnerBalance: false };
  }

  const lines: RenewalReviewAddOnLine<T>[] = [];
  for (const { subscriptionId, selectedIds, query } of requiredQueries) {
    const catalog = query!.data!.addOns;
    for (const addOnId of selectedIds) {
      const addOn = catalog.find((candidate) => candidate.id === addOnId);
      const price = addOn?.prices.find((candidate) => candidate.currency === input.currency);
      if (!addOn || !price || addCurrencyAmounts([price.price]) === null) {
        return { status: 'ERROR', lines: [], addOnTotal: '0', allowsPartnerBalance: false };
      }
      lines.push({ subscriptionId, addOn, price: price.price });
    }
  }

  const addOnTotal = addCurrencyAmounts(lines.map((line) => line.price));
  if (lines.length !== selectionCount || addOnTotal === null) {
    return { status: 'ERROR', lines: [], addOnTotal: '0', allowsPartnerBalance: false };
  }
  return { status: 'READY', lines, addOnTotal, allowsPartnerBalance: false };
}
