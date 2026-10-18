// @vitest-environment jsdom

/**
 * An SBP subscription at Antilopay gives the plan with its FIRST CHARGE, never
 * with the payer confirming it in the bank (the operator's complaint and the
 * owner's rules of 18.10.2026; panel 0.9.7.77). The payment page used to read
 * such a checkout by its status alone:
 *
 *  - with a delay, the checkout waits days for its charge — the panel closes it
 *    meanwhile (CANCELED), which the page called «Платёж не прошёл»;
 *  - without one, a bank slower than the page's minute of polling ended on the
 *    timeout screen.
 *
 * The panel now says how the sign-up stands (`autopaySignUp`), and the page
 * says it too: the subscription is set up, the plan comes with the charge —
 * on a date, or when the bank charges — or that charge did not come.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentStatus: vi.fn(),
  abandonCheckout: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams("paymentId=pay-sbp"), vi.fn()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    path: () => null,
  },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => queryClient }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { primary: "#ffffff" } }),
}));

import PaymentReturnPage from "../src/features/payment/payment-return-page";
import { firstChargeIsLater, resolvePaymentResult } from "../src/features/payment/payment-result-policy";
import { resolveNotificationTarget } from "../src/lib/notification-target";
import { readPendingCheckout, savePendingCheckout } from "../src/lib/pending-checkout";
import {
  readSubscriptionProvisioningReceipt,
  saveSubscriptionProvisioningReceipt,
} from "../src/lib/subscription-provisioning-receipt";

const PAYMENT_ID = "pay-sbp";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<PaymentReturnPage />);
  });
}

function status(overrides: Record<string, unknown>) {
  return {
    paymentId: PAYMENT_ID,
    status: "PENDING",
    purchaseType: "NEW",
    subscriptionProvisioningStatus: null,
    failureReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.sessionStorage.clear();
  window.localStorage.clear();
  savePendingCheckout(PAYMENT_ID, "https://pay.example/invoice", { returnTo: "/plans" });
  saveSubscriptionProvisioningReceipt({
    paymentId: PAYMENT_ID,
    purchaseType: "NEW",
    slotIndex: 0,
    slotIndexSource: "CHECKOUT",
    phase: "AWAITING_PAYMENT",
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the payment page of an SBP sign-up whose plan comes with its first charge", () => {
  it("says the autopay is set up and when the first charge comes, for a delay days long — never «Платёж не прошёл»", async () => {
    const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    // The panel closed the checkout while the delay runs.
    api.getPaymentStatus.mockResolvedValue(
      status({ status: "CANCELED", autopaySignUp: { state: "AWAITING_FIRST_CHARGE", firstChargeAt: inAWeek } }),
    );
    mount();
    await settle();

    const text = container?.textContent ?? "";
    expect(text).toContain("paymentAnim.autopayAwaitingTitle");
    expect(text).toContain("paymentAnim.autopayAwaitingHintDate");
    expect(text).not.toContain("paymentAnim.failed");
    expect(api.getPaymentStatus).toHaveBeenCalledTimes(1);
    // Nothing to reopen and nothing provisioning: the plan comes days later.
    expect(readPendingCheckout(PAYMENT_ID)).toBeNull();
    expect(readSubscriptionProvisioningReceipt(PAYMENT_ID)).toBeNull();
  });

  it("waits for a charge made at activation, and ends on «автоплатёж подключён» instead of the timeout", async () => {
    vi.useFakeTimers();
    api.getPaymentStatus.mockResolvedValue(status({ autopaySignUp: { state: "AWAITING_FIRST_CHARGE", firstChargeAt: null } }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container?.textContent ?? "").toContain("paymentAnim.processing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000 * 31);
    });

    const text = container?.textContent ?? "";
    expect(text).toContain("paymentAnim.autopayAwaitingTitle");
    expect(text).toContain("paymentAnim.autopayAwaitingHint");
    expect(text).not.toContain("paymentAnim.failed");
    expect(api.getPaymentStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("delivers like any payment when the charge comes while the page polls", async () => {
    api.getPaymentStatus
      .mockResolvedValueOnce(status({ autopaySignUp: { state: "AWAITING_FIRST_CHARGE", firstChargeAt: null } }))
      .mockResolvedValue(status({ status: "COMPLETED", autopaySignUp: null }));
    vi.useFakeTimers();
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container?.textContent ?? "").toContain("paymentAnim.success");
  });

  it("says the bank did not make the first charge when it did not come", async () => {
    api.getPaymentStatus.mockResolvedValue(
      status({
        status: "FAILED",
        failureReason: "AUTOPAY_FIRST_CHARGE_FAILED",
        autopaySignUp: { state: "FIRST_CHARGE_FAILED", firstChargeAt: null },
      }),
    );
    mount();
    await settle();

    const text = container?.textContent ?? "";
    expect(text).toContain("paymentAnim.failed");
    expect(text).toContain("paymentAnim.autopayChargeFailedHint");
    expect(text).not.toContain("paymentAnim.failedHint");
    expect(api.getPaymentStatus).toHaveBeenCalledTimes(1);
  });

  it("reads a panel that says nothing of it as before", async () => {
    api.getPaymentStatus.mockResolvedValue(status({ status: "CANCELED" }));
    mount();
    await settle();
    expect(container?.textContent ?? "").toContain("paymentAnim.failedHint");
  });
});

describe("the policy behind it", () => {
  it("puts a delivered payment first, then the sign-up's word, then the status", () => {
    const awaiting = { state: "AWAITING_FIRST_CHARGE" as const, firstChargeAt: null };
    const failed = { state: "FIRST_CHARGE_FAILED" as const, firstChargeAt: null };
    expect(resolvePaymentResult({ status: "COMPLETED", checkoutUrl: null, autopaySignUp: awaiting })).toBe("success");
    expect(resolvePaymentResult({ status: "CANCELED", checkoutUrl: null, autopaySignUp: awaiting })).toBe("awaiting-charge");
    expect(resolvePaymentResult({ status: "PENDING", checkoutUrl: null, autopaySignUp: awaiting })).toBe("awaiting-charge");
    expect(resolvePaymentResult({ status: "FAILED", checkoutUrl: null, autopaySignUp: failed })).toBe("charge-failed");
    expect(resolvePaymentResult({ status: "CANCELED", checkoutUrl: null, autopaySignUp: null })).toBe("failed");
    expect(resolvePaymentResult({ status: "PENDING", checkoutUrl: null })).toBe("processing");
  });

  it("stops waiting only for a first charge more than a few minutes away", () => {
    const now = Date.parse("2026-10-18T09:00:00Z");
    expect(firstChargeIsLater({ state: "AWAITING_FIRST_CHARGE", firstChargeAt: "2026-10-25T00:00:00.000Z" }, now)).toBe(true);
    expect(firstChargeIsLater({ state: "AWAITING_FIRST_CHARGE", firstChargeAt: "2026-10-18T09:05:00.000Z" }, now)).toBe(false);
    expect(firstChargeIsLater({ state: "AWAITING_FIRST_CHARGE", firstChargeAt: null }, now)).toBe(false);
    expect(firstChargeIsLater(null, now)).toBe(false);
  });
});

describe("«Автосписание не прошло» in the bell", () => {
  it("opens where the customer can pay: the plans for a subscription never made, the renewal for one they have", () => {
    expect(resolveNotificationTarget("autopay_first_charge_failed_new")).toEqual({ kind: "route", path: "/plans" });
    expect(resolveNotificationTarget("autopay_first_charge_failed")).toEqual({ kind: "route", path: "/renew" });
  });
});
