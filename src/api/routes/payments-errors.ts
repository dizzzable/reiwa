import { UpstreamError } from "../../core/errors/upstream-error.js";

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const MAX_FRACTION_DIGITS = 8;

/** Converts a non-negative decimal/scientific amount to the Decimal(20,8) wire form. */
export function normalizeWireDecimal(value: string): string | null {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;

  const integerPart = match[1]!.replace(/^0+(?=\d)/, "");
  const fractionPart = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = `${integerPart}${fractionPart}`;
  const decimalPosition = integerPart.length + exponent;
  let whole: string;
  let fraction: string;
  if (decimalPosition <= 0) {
    whole = "0";
    fraction = `${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    whole = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
    fraction = "";
  } else {
    whole = digits.slice(0, decimalPosition);
    fraction = digits.slice(decimalPosition);
  }

  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length > MAX_FRACTION_DIGITS) return null;
  return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export interface RenewalCheckoutErrorResponse {
  status: number;
  body: { code: string; message: string };
}

const RENEWAL_ERROR_MESSAGES: Record<string, { status: number; message: string }> = {
  QUOTE_CHANGED: {
    status: 409,
    message: "Renewal quote changed; refresh the review before paying",
  },
  IDEMPOTENCY_KEY_CONFLICT: {
    status: 409,
    message: "This retry key belongs to a different renewal. Start checkout again.",
  },
  PROVIDER_CHECKOUT_CREATION_UNRESOLVED: {
    status: 502,
    message: "Payment creation status is unresolved. Check payment status before retrying.",
  },
};

/** Maps known upstream renewal outcomes to a safe, stable BFF contract. */
export function resolveRenewalCheckoutError(
  error: UpstreamError,
): RenewalCheckoutErrorResponse | null {
  let code: unknown;
  try {
    const payload: unknown = JSON.parse(error.body);
    if (payload && typeof payload === "object" && "code" in payload) {
      code = (payload as { code?: unknown }).code;
    }
  } catch {
    // Fall through to the safe conflict fallback below.
  }

  if (typeof code === "string" && RENEWAL_ERROR_MESSAGES[code]) {
    const contract = RENEWAL_ERROR_MESSAGES[code]!;
    return { status: contract.status, body: { code, message: contract.message } };
  }
  if (error.status === 409) {
    const contract = RENEWAL_ERROR_MESSAGES.QUOTE_CHANGED!;
    return {
      status: contract.status,
      body: { code: "QUOTE_CHANGED", message: contract.message },
    };
  }
  return null;
}
