/**
 * What the add-on purchase says when the panel refuses it, and where the
 * wizard goes next.
 *
 * The cabinet forwards a refusal the panel names as `{ code, message }`
 * (`src/api/routes/add-on-purchase-errors.ts`); everything else still arrives
 * as the generic «Add-on purchase failed». Each code gets words that say what
 * happened and the next step — choose another add-on, another payment method,
 * renew the subscription first, wait — and the wizard returns to the step
 * where that step is taken, with what went stale read again. A failure without
 * a known code keeps today's answer: «Не удалось создать платёж. Попробуйте
 * позже.» and the confirmation screen.
 */
import type { AddOnStep } from "@/stores/addons.store";

/**
 * Mirrors `ADD_ON_PURCHASE_REFUSAL_CODES` in
 * `src/api/routes/add-on-purchase-errors.ts`, which the cabinet forwards.
 * Restated rather than imported: this module is in the browser bundle and that
 * one is server code. `test/web/add-on-purchase-refusal-contract.test.ts`
 * compares the two lists.
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

/** What the page reads again before the subscriber takes the next step. */
export type AddOnPurchaseReread = "eligibility" | "gateways" | "subscriptions" | "policy";

export interface AddOnPurchaseFailureAnswer {
  /** The toast, as an i18n key. */
  readonly messageKey: string;
  /** Where the wizard goes: the step at which the next step is taken. */
  readonly step: AddOnStep;
  readonly reread: readonly AddOnPurchaseReread[];
}

/** Today's answer, for everything without a known code. */
export const GENERIC_ADD_ON_PURCHASE_FAILURE: AddOnPurchaseFailureAnswer = {
  messageKey: "addons.purchaseError",
  step: "review",
  reread: [],
};

const ANSWERS: Readonly<Record<AddOnPurchaseRefusalCode, AddOnPurchaseFailureAnswer>> = {
  // Withheld by the listing too, so the list read again no longer offers it.
  ADDON_LIFETIME_UNAVAILABLE: { messageKey: "addons.refusal.unavailable", step: "addon", reread: ["eligibility"] },
  ADDON_NOT_AVAILABLE: { messageKey: "addons.refusal.unavailable", step: "addon", reread: ["eligibility"] },
  ADDON_ALREADY_UNLIMITED: { messageKey: "addons.refusal.alreadyUnlimited", step: "addon", reread: ["eligibility"] },
  // The subscription list shows active subscriptions only.
  ADDON_SUBSCRIPTION_NOT_ACTIVE: {
    messageKey: "addons.refusal.subscriptionInactive",
    step: "subscriptions",
    reread: ["subscriptions", "eligibility"],
  },
  // Back to the list, not the payment methods: the add-on held by the wizard
  // carries the prices the methods are filtered by, and those are the stale ones.
  ADDON_NO_PRICE_FOR_GATEWAY: { messageKey: "addons.refusal.changed", step: "addon", reread: ["eligibility"] },
  ADDON_REVISION_CONFLICT: { messageKey: "addons.refusal.changed", step: "addon", reread: ["eligibility"] },
  // The confirmation mints a fresh key on the next «Перейти к оплате».
  IDEMPOTENCY_KEY_CONFLICT: { messageKey: "addons.refusal.attemptOutdated", step: "review", reread: [] },
  PROVIDER_OUTCOME_UNKNOWN: { messageKey: "addons.refusal.providerNoAnswer", step: "review", reread: [] },
  PAYMENT_GATEWAY_NOT_ACTIVE: { messageKey: "addons.refusal.paymentMethod", step: "gateway", reread: ["gateways"] },
  PAYMENT_GATEWAY_NOT_CONFIGURED: { messageKey: "addons.refusal.paymentMethod", step: "gateway", reread: ["gateways"] },
  PAYMENT_GATEWAY_CURRENCY_UNSUPPORTED: {
    messageKey: "addons.refusal.paymentMethod",
    step: "gateway",
    reread: ["gateways"],
  },
  PAYMENT_GATEWAY_CHANNEL_UNSUPPORTED: { messageKey: "addons.refusal.telegramOnly", step: "gateway", reread: ["gateways"] },
  // The policy is read again, so the page goes behind its «Покупки временно
  // отключены» / «Сервис временно недоступен» screen as soon as the cabinet's
  // copy of the policy says so (the panel can refuse a minute before it does).
  PURCHASES_DISABLED: { messageKey: "addons.refusal.purchasesDisabled", step: "review", reread: ["policy"] },
  SERVICE_RESTRICTED: { messageKey: "addons.refusal.serviceRestricted", step: "review", reread: ["policy"] },
};

function isRefusalCode(value: unknown): value is AddOnPurchaseRefusalCode {
  return (ADD_ON_PURCHASE_REFUSAL_CODES as readonly unknown[]).includes(value);
}

/**
 * The coded refusal behind a failed `purchaseAddOn`, or `null` when the
 * failure is anything else. A 401 is never one: the session is gone, and the
 * transport has already sent the subscriber to sign in.
 */
export function readAddOnPurchaseRefusal(error: unknown): AddOnPurchaseRefusalCode | null {
  if (typeof error !== "object" || error === null) return null;
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
  const status = response?.status;
  if (typeof status !== "number" || status < 400 || status > 599 || status === 401) return null;
  const data = response?.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return isRefusalCode(code) ? code : null;
}

/** What the page says about a failed purchase, and where the wizard goes. */
export function answerAddOnPurchaseFailure(error: unknown): AddOnPurchaseFailureAnswer {
  const code = readAddOnPurchaseRefusal(error);
  return code === null ? GENERIC_ADD_ON_PURCHASE_FAILURE : ANSWERS[code];
}
