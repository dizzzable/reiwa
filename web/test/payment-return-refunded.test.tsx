// @vitest-environment jsdom

/**
 * `resolvePaymentResult` has classified REFUNDED as `"failed"` since it was
 * written, and `payment-result-policy.test.ts` proves it. The return page then
 * threw that verdict away and re-derived the terminal state from the raw
 * status, which listed only FAILED and CANCELED — so a refunded payment kept
 * polling to the 30-poll cap, landed the buyer on the *timeout* screen, and
 * never cleared the stored pending checkout.
 *
 * This mounts the real page so the policy is exercised through the call site.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentStatus: vi.fn(),
  abandonCheckout: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
// Stable across renders, like the real context value — the polling effect
// lists the query client in its deps and would otherwise restart every render.
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams("paymentId=pay-refunded"), vi.fn()],
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
import { readPendingCheckout, savePendingCheckout } from "../src/lib/pending-checkout";
import {
  readSubscriptionProvisioningReceipt,
  saveSubscriptionProvisioningReceipt,
} from "../src/lib/subscription-provisioning-receipt";

const PAYMENT_ID = "pay-refunded";

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PaymentReturnPage terminal states", () => {
  it("settles a REFUNDED payment on the failed screen and clears its stored checkout", async () => {
    api.getPaymentStatus.mockResolvedValue({
      paymentId: PAYMENT_ID,
      status: "REFUNDED",
      purchaseType: "NEW",
      subscriptionProvisioningStatus: null,
      failureReason: null,
    });

    mount();
    await settle();

    const text = container?.textContent ?? "";
    expect(text).toContain("paymentAnim.failed");
    expect(text).not.toContain("paymentAnim.processing");
    // One poll, not the 30-poll / ~60s cap that used to end on `timeout`.
    expect(api.getPaymentStatus).toHaveBeenCalledTimes(1);
    // `timeout` renders the same screen plus the "open payment" button; a
    // settled invoice must not offer to be reopened.
    expect(text).not.toContain("paymentAnim.openPayment");
    expect(readPendingCheckout(PAYMENT_ID)).toBeNull();
    expect(readSubscriptionProvisioningReceipt(PAYMENT_ID)).toBeNull();
  });

  it("keeps CANCELED on the same failed screen", async () => {
    api.getPaymentStatus.mockResolvedValue({
      paymentId: PAYMENT_ID,
      status: "CANCELED",
      purchaseType: "NEW",
      subscriptionProvisioningStatus: null,
      failureReason: null,
    });

    mount();
    await settle();

    expect(container?.textContent ?? "").toContain("paymentAnim.failed");
    expect(api.getPaymentStatus).toHaveBeenCalledTimes(1);
    expect(readPendingCheckout(PAYMENT_ID)).toBeNull();
  });
});
