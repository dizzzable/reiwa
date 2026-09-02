// @vitest-environment jsdom

/**
 * Loyalty cashback on the payment-return success screen.
 *
 * The credited number exists in exactly one place — the payment status object
 * inside the poll closure — and the screen it belongs on erases itself on a
 * timer. So three things have to hold together, and each has already been a
 * way to lose the message:
 *
 *  - the line is rendered at all, with the real count (it is read once, in the
 *    success branch, and the status object is not stored anywhere else);
 *  - the auto-redirect is LENGTHENED when there is something to read. At the
 *    3500 ms the screen normally uses, the sentence and its button are gone
 *    before they register — so the spec advances past 3500 ms and demands the
 *    page is still there;
 *  - the exchange button pre-empts that redirect. Navigating without cancelling
 *    the pending timer leaves it to fire behind the exchange page and replace
 *    it with the dashboard, which is the whole defect this guards.
 *
 * The no-cashback case is the control: same screen, same purchase type, none of
 * the copy, and the original 3500 ms delay intact.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentStatus: vi.fn(),
  abandonCheckout: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
// Stable across renders, like the real context value — the polling effect lists
// the query client in its deps and would otherwise restart every render.
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams("paymentId=pay-cashback"), vi.fn()],
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
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

const PAYMENT_ID = "pay-cashback";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** A RENEW keeps `provisioningSuccessRef` false, so the baseline delay is the
 *  ordinary 3500 ms one the cashback case has to beat. */
function completed(cashbackPoints?: number | null): Record<string, unknown> {
  return {
    paymentId: PAYMENT_ID,
    status: "COMPLETED",
    purchaseType: "RENEW",
    subscriptionProvisioningStatus: "NOT_APPLICABLE",
    failureReason: null,
    ...(cashbackPoints === undefined ? {} : { cashbackPoints }),
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

function text(): string {
  return container?.textContent ?? "";
}

function exchangeButton(): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll("button") ?? [])].find((b) =>
    b.textContent?.includes("paymentAnim.cashbackExchange"),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
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

describe("PaymentReturnPage cashback", () => {
  it("announces the credited points and holds the screen long enough to read them", async () => {
    api.getPaymentStatus.mockResolvedValue(completed(13));

    mount();
    await advance(0);

    expect(text()).toContain("paymentAnim.success");
    expect(text()).toContain('paymentAnim.cashbackCredited:{"count":13}');
    expect(text()).toContain("paymentAnim.cashbackExchange");

    // Past the ordinary 3500 ms and still on screen — the reason the delay is
    // extended at all.
    await advance(3600);
    expect(navigate).not.toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(text()).toContain('paymentAnim.cashbackCredited:{"count":13}');

    // …but it does still leave on its own.
    await advance(2500);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });

  it("sends the exchange button straight to the points page and cancels the redirect", async () => {
    api.getPaymentStatus.mockResolvedValue(completed(13));

    mount();
    await advance(0);

    const button = exchangeButton();
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });

    expect(navigate).toHaveBeenCalledWith("/referrals/exchange");

    // The pending hop must be dead, not merely outrun: left armed it would fire
    // behind the exchange page and replace it with the dashboard.
    await advance(10_000);
    expect(navigate).not.toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("says nothing, and keeps the original delay, when the payment credited no points", async () => {
    api.getPaymentStatus.mockResolvedValue(completed());

    mount();
    await advance(0);

    expect(text()).toContain("paymentAnim.success");
    expect(text()).not.toContain("paymentAnim.cashbackCredited");
    expect(text()).not.toContain("paymentAnim.cashbackExchange");

    await advance(3400);
    expect(navigate).not.toHaveBeenCalledWith("/dashboard", { replace: true });
    await advance(200);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });

  it("treats an explicit zero the same as an absent field", async () => {
    api.getPaymentStatus.mockResolvedValue(completed(0));

    mount();
    await advance(0);

    expect(text()).toContain("paymentAnim.success");
    expect(text()).not.toContain("paymentAnim.cashbackCredited");
  });
});
