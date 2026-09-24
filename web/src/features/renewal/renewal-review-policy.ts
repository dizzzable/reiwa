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
