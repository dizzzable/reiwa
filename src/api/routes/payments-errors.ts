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

/**
 * Detect SUBSCRIPTION_LIMIT_REACHED in an upstream (admin) error body.
 * Handles:
 *   - `{ code: "SUBSCRIPTION_LIMIT_REACHED", message: "..." }`
 *   - `{ errorCode: "SUBSCRIPTION_LIMIT_REACHED", ... }` (AdminSafeExceptionFilter)
 *   - Nest nested `{ message: { code, message } }`
 *   - Plain English message from createDraft capacity guard
 */
export function extractSubscriptionLimitCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      code?: string;
      errorCode?: string;
      message?: string | { code?: string; message?: string };
    };
    if (parsed.code === "SUBSCRIPTION_LIMIT_REACHED") return "SUBSCRIPTION_LIMIT_REACHED";
    if (parsed.errorCode === "SUBSCRIPTION_LIMIT_REACHED") return "SUBSCRIPTION_LIMIT_REACHED";
    if (
      parsed.message &&
      typeof parsed.message === "object" &&
      parsed.message.code === "SUBSCRIPTION_LIMIT_REACHED"
    ) {
      return "SUBSCRIPTION_LIMIT_REACHED";
    }
    const msg =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.message === "object" && parsed.message
          ? parsed.message.message
          : undefined;
    if (
      typeof msg === "string" &&
      /maximum number of active subscriptions|subscription limit reached/i.test(msg)
    ) {
      return "SUBSCRIPTION_LIMIT_REACHED";
    }
  } catch {
    if (/maximum number of active subscriptions|subscription limit reached/i.test(body)) {
      return "SUBSCRIPTION_LIMIT_REACHED";
    }
  }
  return undefined;
}

/**
 * Checkout refusals rezeis reports as a stable product code, forwarded to the
 * SPA as a typed 400 instead of a generic 500.
 *
 * Each one asks the buyer for something different, and the difference is the
 * whole point: "your trial is spent" and "your own unfinished attempt is in the
 * way" look identical once they collapse into "Failed to create checkout" —
 * which is how the original report started.
 */
const CHECKOUT_ERROR_CODES = new Set([
  "TRIAL_ALREADY_USED",
  "TRIAL_PENDING_CHECKOUT_STALE",
  // The panel will not turn the quote into a draft; nothing was charged. As a
  // 500 the purchase page could only say "failed to create payment" over a
  // spinner that never stopped. A panel older than the code below also sends
  // this for a withdrawn plan, so the page re-prices the quote to tell which.
  "PAYMENT_DRAFT_QUOTE_NOT_ELIGIBLE",
  // The plan (or its term) is no longer sold: an operator archived or deleted
  // it while the buyer still had the old catalogue on screen. This one the page
  // answers by saying the plan is gone and sending the buyer back to a freshly
  // loaded catalogue — an answer that is only right for this refusal.
  "PAYMENT_DRAFT_PLAN_NOT_AVAILABLE",
  // «для автоматического списания» is refused for this purchase (a promo
  // price, kopecks, a term the provider has no period for, add-ons, several
  // subscriptions, or approval switched off since the list loaded). Nothing
  // was created; the page offers the ordinary payment instead.
  "AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE",
]);

/** Abandon refusals, reported by rezeis as 409. */
const ABANDON_ERROR_CODES = new Set([
  "PAYMENT_ALREADY_AT_PROVIDER",
  "PAYMENT_PROVIDER_CREATE_IN_FLIGHT",
]);

/** Pulls a product `code` out of the shapes an admin-side error arrives in. */
function upstreamProductCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      errorCode?: unknown;
      message?: unknown;
    };
    if (typeof parsed.code === "string") return parsed.code;
    if (typeof parsed.errorCode === "string") return parsed.errorCode;
    const nested = parsed.message;
    if (nested && typeof nested === "object" && "code" in nested) {
      const code = (nested as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  } catch {
    // Not JSON — no product code to find.
  }
  return undefined;
}

/** The checkout refusal in an upstream error body, if it is one we forward. */
export function extractCheckoutRefusalCode(body: string): string | undefined {
  const code = upstreamProductCode(body);
  return code !== undefined && CHECKOUT_ERROR_CODES.has(code) ? code : undefined;
}

/** The abandon refusal in an upstream error body, if it is one we forward. */
export function extractAbandonRefusalCode(body: string): string | undefined {
  const code = upstreamProductCode(body);
  return code !== undefined && ABANDON_ERROR_CODES.has(code) ? code : undefined;
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
  // rezeis refusing to price a subscription on the reviewed terms, usually
  // because its plan was withdrawn between the buyer's review and their Pay.
  // It used to arrive with no code at all and leave here as a 500 "Failed to
  // create renewal checkout", a server fault for a state change. Answered as a
  // conflict, like QUOTE_CHANGED, and handled the same way by the renewal
  // page: it re-prices the review and sends the buyer back to it.
  RENEWAL_ITEM_NOT_PRICEABLE: {
    status: 409,
    message: "A subscription can no longer be renewed on these terms. Review the renewal again.",
  },
  // «для автоматического списания» refused for this renewal; nothing was
  // created. A 400, not a conflict: reviewing again changes nothing, the
  // ordinary payment does.
  AUTOPAY_NOT_AVAILABLE_FOR_PURCHASE: {
    status: 400,
    message: "Automatic charging is not available for this renewal. Choose the ordinary payment.",
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
