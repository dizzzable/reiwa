// @vitest-environment jsdom

/**
 * `/payment-return` makes the next dashboard eligible for the push prompt —
 * when, and only when, the payment came back PAID.
 *
 * This is the path for everything the provisioning handoff does not see: a
 * renewal, an upgrade or an add-on paid in another tab, or in the Mini App's
 * browser. A declined, cancelled or refunded payment, or one still being
 * processed, offers nothing: a customer whose card was just declined must not
 * be asked about reminders for a subscription they do not have.
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
  useSearchParams: () => [new URLSearchParams("paymentId=pay-push"), vi.fn()],
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
import {
  isPushPromptEligible,
  resetPushPromptMemoryForTests,
} from "../src/features/push-prompt/push-prompt-storage";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function status(value: string): Record<string, unknown> {
  return {
    paymentId: "pay-push",
    status: value,
    purchaseType: "RENEW",
    subscriptionProvisioningStatus: "NOT_APPLICABLE",
    failureReason: null,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
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
  vi.useFakeTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetPushPromptMemoryForTests();
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

describe("/payment-return and the push prompt", () => {
  it("a paid return makes the dashboard it hands over to eligible", async () => {
    api.getPaymentStatus.mockResolvedValue(status("COMPLETED"));
    expect(isPushPromptEligible()).toBe(false);

    mount();
    await advance(0);

    expect(container?.textContent).toContain("paymentAnim.success");
    expect(isPushPromptEligible(), "a paid return offered nothing").toBe(true);
  });

  it.each(["FAILED", "CANCELED", "REFUNDED"])("a %s payment offers nothing", async (value) => {
    api.getPaymentStatus.mockResolvedValue(status(value));

    mount();
    await advance(0);

    expect(container?.textContent).toContain("paymentAnim.failed");
    expect(isPushPromptEligible()).toBe(false);
  });

  it("a payment still being processed offers nothing yet", async () => {
    api.getPaymentStatus.mockResolvedValue(status("PENDING"));

    mount();
    await advance(0);
    await advance(2_100);

    expect(api.getPaymentStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(isPushPromptEligible()).toBe(false);
  });
});
