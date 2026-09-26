import { UpstreamError } from "../../core/errors/upstream-error.js";

/**
 * Why the panel refused an add-on checkout, forwarded to the purchase page as a
 * code — and nothing else the panel said.
 *
 * `POST /add-ons/purchase` used to answer every failure with a bare 400 «Add-on
 * purchase failed» (`sendSafeError`), so the subscriber read «Не удалось создать
 * платёж. Попробуйте позже.» for a refusal that retrying never changes: an
 * add-on withdrawn while the page was open, a subscription that has lapsed, a
 * payment method switched off. The page cannot say what to do next unless it
 * knows which refusal it was.
 *
 * ── How the panel says it ─────────────────────────────────────────────────
 *
 * The panel's checkout (rezeis-admin `payments/services/addon-purchase.service.ts`)
 * throws in three shapes, and its `AdminSafeExceptionFilter` decides what
 * survives to the wire:
 *
 *  - `{ code, message }` with a code on the filter's `SAFE_PRODUCT_CODES`
 *    (`PURCHASES_DISABLED`, `SERVICE_RESTRICTED`, `IDEMPOTENCY_KEY_CONFLICT`):
 *    the body carries `code` (and `errorCode`, the same value).
 *  - `{ code, message }` with a code NOT on that list up to Rezeis Admin
 *    0.9.7.70 (`ADDON_LIFETIME_UNAVAILABLE`, `ADDON_REVISION_CONFLICT`,
 *    `PROVIDER_OUTCOME_UNKNOWN`): the filter strips the code and keeps the
 *    sentence, with `errorCode` derived from the status (`BAD_REQUEST`,
 *    `CONFLICT`, `INTERNAL_SERVER_ERROR`). The pair's E2E suite reads the
 *    lifetime refusal off its sentence for exactly this reason.
 *  - a bare string: either code-shaped (`PAYMENT_GATEWAY_NOT_ACTIVE`, which is
 *    then the whole `message`) or an English sentence («Add-ons require an
 *    active subscription»), which is all that is ever said.
 *
 * From Rezeis Admin 0.9.7.71 the filter forwards the add-on codes too (and
 * `USER_BLOCKED`). So a refusal is read by its CODE whenever the body carries
 * one: the code decides alone, whatever the status and whatever sentence is
 * beside it, and a code this table does not forward is not reinterpreted from
 * its sentence. Only a body with no code — 0.9.7.70 and older — is recognised
 * by the status the panel throws it with AND its own sentence, compared WHOLE
 * and EXACTLY (`sentences`). A sentence the panel rewords stops matching and
 * the refusal falls back to the generic answer, as before: the failure mode of
 * that table is today's behaviour, never a wrong reason.
 *
 * ── What reaches the browser ──────────────────────────────────────────────
 *
 * The code, and a fixed English sentence written here. Never the panel's
 * sentence, its `errorCode`, its path or request id: the body the panel sent
 * stays in the server log. The page words each code in the subscriber's
 * language (`web/src/features/addons/purchase-refusal.ts`, which restates this
 * list; `test/web/add-on-purchase-refusal-contract.test.ts` keeps the two
 * equal).
 *
 * The status is chosen here too, not copied: 400 for a refusal of what was
 * asked, 409 for a conflict with a newer state, 502 when the payment provider
 * did not answer (as `PROVIDER_CHECKOUT_CREATION_UNRESOLVED` does on the renewal
 * route), and for the two platform access-mode codes exactly what this route's
 * own gate answers for them (`middleware/access-mode.ts`), so the page meets
 * one contract whichever of the two refused — whatever status the panel used.
 * Anything not listed — another code, no code and another sentence, a 401 from
 * the panel's token check, a validation error, a provider's own text — keeps
 * the generic answer.
 */
export const ADD_ON_PURCHASE_REFUSAL_CODES = [
  "ADDON_LIFETIME_UNAVAILABLE",
  "ADDON_NOT_AVAILABLE",
  "ADDON_ALREADY_UNLIMITED",
  "ADDON_SUBSCRIPTION_NOT_ACTIVE",
  "ADDON_NO_PRICE_FOR_GATEWAY",
  "ADDON_REVISION_CONFLICT",
  "IDEMPOTENCY_KEY_CONFLICT",
  "PROVIDER_OUTCOME_UNKNOWN",
  "PAYMENT_GATEWAY_NOT_ACTIVE",
  "PAYMENT_GATEWAY_NOT_CONFIGURED",
  "PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED",
  "PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED",
  "PURCHASES_DISABLED",
  "SERVICE_RESTRICTED",
] as const;

export type AddOnPurchaseRefusalCode = (typeof ADD_ON_PURCHASE_REFUSAL_CODES)[number];

interface RefusalRule {
  /**
   * The statuses the panel throws this refusal with. Read only with
   * `sentences`, for a body that names no code: a code decides alone.
   */
  readonly arrives: readonly number[];
  /**
   * The panel's own `message`, whole, for a body that names no code: the
   * sentence it throws, or the code itself where the code IS the message.
   */
  readonly sentences: readonly string[];
  /** What this route answers with. */
  readonly status: number;
  /** A fixed sentence for API readers and logs; the page words the code itself. */
  readonly message: string;
}

const RULES: Readonly<Record<AddOnPurchaseRefusalCode, RefusalRule>> = {
  // The add-on cannot be delivered for the period it is sold for on this
  // subscription (a «до сброса» add-on with no reset window to bind to: the
  // stage switch off, a plan without resets, no reset anchor), so the panel
  // refuses rather than sell a permanent top-up at a price set for less. The
  // pair patch adds the second sentence: a «до сброса» add-on asked for by a
  // cabinet that cannot show its reset end. The listing withholds both, so the
  // page reaches them only with a list read before the change.
  ADDON_LIFETIME_UNAVAILABLE: {
    arrives: [400],
    sentences: [
      "This add-on cannot be delivered for its advertised period on this subscription",
      "This add-on ends at the next traffic reset, which the calling cabinet cannot show; update Reiwa",
    ],
    status: 400,
    message: "The add-on cannot be sold for its period on this subscription",
  },
  // Switched off or deleted by the operator (404), or no longer applicable to
  // the subscription's plan (400).
  ADDON_NOT_AVAILABLE: {
    arrives: [400, 404],
    sentences: ["Add-on not found", "Add-on is not available for this subscription plan"],
    status: 400,
    message: "The add-on is not offered for this subscription",
  },
  // The subscription's limit for what the add-on adds is already unlimited.
  ADDON_ALREADY_UNLIMITED: {
    arrives: [400],
    sentences: [
      "Subscription has unlimited traffic — extra traffic cannot be applied",
      "Subscription has unlimited devices — extra devices cannot be applied",
    ],
    status: 400,
    message: "The subscription is already unlimited in what the add-on adds",
  },
  // Neither ACTIVE nor LIMITED: expired, disabled or deleted.
  ADDON_SUBSCRIPTION_NOT_ACTIVE: {
    arrives: [400],
    sentences: ["Add-ons require an active subscription"],
    status: 400,
    message: "The subscription is not active",
  },
  // The add-on has no price in the chosen method's currency (removed while the
  // page held the old prices; the page offers only methods it has a price for).
  ADDON_NO_PRICE_FOR_GATEWAY: {
    arrives: [400],
    sentences: ["Add-on has no price for the selected payment method"],
    status: 400,
    message: "The add-on has no price for the chosen payment method",
  },
  // The operator changed the add-on after the page read it (the page pins the
  // revision it showed).
  ADDON_REVISION_CONFLICT: {
    arrives: [409],
    sentences: ["Add-on changed since it was shown; refresh and try again"],
    status: 409,
    message: "The add-on changed since it was shown",
  },
  // The page's retry key was already used for a different composition.
  IDEMPOTENCY_KEY_CONFLICT: {
    arrives: [409],
    sentences: ["Idempotency key was already used for a different checkout"],
    status: 409,
    message: "This checkout attempt is out of date",
  },
  // The provider did not answer the create (timeout, 5xx, network, a missing
  // gateway setting). The draft is kept for reconciliation; no payment page
  // was handed to the subscriber.
  PROVIDER_OUTCOME_UNKNOWN: {
    arrives: [503],
    sentences: ["Payment provider outcome is unknown; awaiting reconciliation"],
    status: 502,
    message: "The payment provider did not answer; no payment was opened",
  },
  PAYMENT_GATEWAY_NOT_ACTIVE: {
    arrives: [400],
    sentences: ["PAYMENT_GATEWAY_NOT_ACTIVE"],
    status: 400,
    message: "The payment method is not active",
  },
  PAYMENT_GATEWAY_NOT_CONFIGURED: {
    arrives: [400],
    sentences: ["PAYMENT_GATEWAY_NOT_CONFIGURED"],
    status: 400,
    message: "The payment method is not configured",
  },
  // Telegram Stars asked for outside the Telegram Mini App.
  PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED: {
    arrives: [400],
    sentences: ["PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED"],
    status: 400,
    message: "The payment method is not available here",
  },
  // A gateway that takes one currency (MulenPay: roubles) holding a price in
  // another — thrown by the provider layer before any request goes out.
  PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED: {
    arrives: [400],
    sentences: ["PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED"],
    status: 400,
    message: "The payment method does not take this currency",
  },
  // The panel's own access-mode gate, when this cabinet's cached policy has
  // not caught up yet. Same status and sentence as `requireMode` answers.
  PURCHASES_DISABLED: {
    arrives: [403],
    sentences: [],
    status: 403,
    message: "New purchases are temporarily unavailable",
  },
  SERVICE_RESTRICTED: {
    arrives: [503],
    sentences: [],
    status: 503,
    message: "Service is temporarily unavailable",
  },
};

export interface AddOnPurchaseRefusal {
  readonly status: number;
  readonly body: { readonly code: AddOnPurchaseRefusalCode; readonly message: string };
}

function isRefusalCode(value: unknown): value is AddOnPurchaseRefusalCode {
  return (ADD_ON_PURCHASE_REFUSAL_CODES as readonly unknown[]).includes(value);
}

/** The product code a body names: top level, or under `message` (Nest's nested shape). */
function namedCode(body: Record<string, unknown>): string | undefined {
  if (typeof body["code"] === "string") return body["code"];
  const nested = body["message"];
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const code = (nested as Record<string, unknown>)["code"];
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * THE CODE FIRST. A body that names a code is read by that code alone —
 * whatever status it came with, whatever sentence stands beside it: ours is
 * forwarded, any other keeps the generic answer and its sentence is never
 * consulted. That is every refusal from Rezeis Admin 0.9.7.71 on, whose filter
 * forwards the add-on codes, and the three codes it always forwarded. Only a
 * body with no code — 0.9.7.70 and older, where the filter stripped it — is
 * read by its status and its exact sentence.
 */
function refusalCodeOf(body: Record<string, unknown>, status: number): AddOnPurchaseRefusalCode | null {
  const code = codeOf(body);
  if (code !== undefined) return isRefusalCode(code) ? code : null;
  return bySentence(body, status);
}

/** The code a body carries: `code` (or Nest's nested one), else a product `errorCode`. */
function codeOf(body: Record<string, unknown>): string | undefined {
  const named = namedCode(body);
  if (named !== undefined) return named;
  // The filter's `errorCode` is a product code only when the filter forwarded
  // one; otherwise it is the status's name (`BAD_REQUEST`) and names nothing.
  const errorCode = body["errorCode"];
  return isRefusalCode(errorCode) ? errorCode : undefined;
}

/** For a body with no code: the refusal thrown with this status and exactly this sentence. */
function bySentence(body: Record<string, unknown>, status: number): AddOnPurchaseRefusalCode | null {
  const message = body["message"];
  if (typeof message !== "string") return null;
  for (const code of ADD_ON_PURCHASE_REFUSAL_CODES) {
    const rule = RULES[code];
    if (rule.sentences.includes(message) && rule.arrives.includes(status)) return code;
  }
  return null;
}

/**
 * The refusal inside a failed add-on checkout, as this route forwards it, or
 * `null` when the failure is anything else — which keeps the generic answer.
 * Read from the typed upstream error only: its status and its JSON body.
 */
export function readAddOnPurchaseRefusal(e: unknown): AddOnPurchaseRefusal | null {
  if (!(e instanceof UpstreamError)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(e.body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const code = refusalCodeOf(parsed as Record<string, unknown>, e.status);
  if (code === null) return null;
  const rule = RULES[code];
  return { status: rule.status, body: { code, message: rule.message } };
}
