// @vitest-environment jsdom

/**
 * «Способы оплаты» while a payment with the method is being made.
 *
 * A charge with a saved card holds the method until its request to ЮKassa ends
 * — up to about 45 s. The customer's «Автосписание» switch and «Отвязать»
 * used to wait for it, past the 30 s the panel gives a request: the page said
 * the change failed while it went through a moment later. The panel now
 * answers at once, 409 `SAVED_PAYMENT_METHOD_BUSY`: nothing changed, try again
 * in a minute. These cases pin that the page says exactly that, and puts the
 * switch back to what the method really is.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPaymentMethods: vi.fn(),
  setPaymentMethodAutopay: vi.fn(),
  unbindPaymentMethod: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
}));
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, initial: _i, animate: _a, transition: _t, ...props }: ComponentProps<"div"> & Record<string, unknown>) => (
      <div {...(props as ComponentProps<"div">)}>{children}</div>
    ),
  },
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/lib/api-client", () => ({
  getPaymentMethods: api.getPaymentMethods,
  setPaymentMethodAutopay: api.setPaymentMethodAutopay,
  unbindPaymentMethod: api.unbindPaymentMethod,
  cancelProviderSubscription: vi.fn(),
  getPaymentMethodSetupStatus: vi.fn(),
  startPaymentMethodSetup: vi.fn(),
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/gateway-icon", () => ({ AutopayGatewayMark: () => null }));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
  }: {
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly onCheckedChange: (next: boolean) => void;
  }) => (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} />
  ),
}));
vi.mock("@/components/ui/stadium-button", () => ({
  StadiumButton: ({ children, variant: _v, ...props }: ComponentProps<"button"> & { readonly variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { readonly children: ReactNode }) => <p>{children}</p>,
}));

import PaymentMethodsPage from "../src/features/settings/payment-methods-page";

const METHOD = {
  id: "pm-1",
  gatewayType: "YOOKASSA",
  methodType: "bank_card",
  title: "Visa •••• 4242",
  cardLast4: "4242",
  cardFirst6: null,
  cardExpiryMonth: null,
  cardExpiryYear: null,
  cardIssuerCountry: null,
  cardProduct: null,
  autopayEnabled: true,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

/** What axios rejects with for the panel's answer, as the cabinet's API forwards it. */
function refusal(status: number, data: Record<string, unknown>): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}
const BUSY = refusal(409, { code: "SAVED_PAYMENT_METHOD_BUSY", message: "A payment with this method is in progress" });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.getPaymentMethods.mockResolvedValue({ methods: [{ ...METHOD }], total: 1, providerSubscriptions: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PaymentMethodsPage />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function autopaySwitch(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("[role='switch']");
  if (found === null) throw new Error("no autopay switch");
  return found;
}

/** «Отвязать» on the card, then «Отвязать» again in the dialog that asks to confirm. */
async function unbindAndConfirm(): Promise<void> {
  const unbind = container.querySelector<HTMLButtonElement>("[aria-label='paymentMethods.unbind']");
  await act(async () => {
    unbind?.click();
  });
  const confirm = [...container.querySelectorAll<HTMLButtonElement>("[data-testid='dialog'] button")].find(
    (button) => button.textContent === "paymentMethods.unbind",
  );
  expect(confirm).toBeDefined();
  await act(async () => {
    confirm?.click();
  });
  await settle();
}

describe("«Автосписание» while a payment with the card is being made", () => {
  it("says the payment is in progress, and puts the switch back to what the card really is", async () => {
    api.setPaymentMethodAutopay.mockRejectedValue(BUSY);
    await render();
    expect(autopaySwitch().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      autopaySwitch().click();
    });
    await settle();

    expect(api.setPaymentMethodAutopay).toHaveBeenCalledWith("pm-1", false);
    expect(toastMock.error).toHaveBeenCalledWith("paymentMethods.autopayBusy");
    expect(toastMock.error).not.toHaveBeenCalledWith("paymentMethods.autopayError");
    expect(autopaySwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps saying the change failed for any other refusal", async () => {
    api.setPaymentMethodAutopay.mockRejectedValue(refusal(400, { message: "Failed to update payment method autopay" }));
    await render();

    await act(async () => {
      autopaySwitch().click();
    });
    await settle();

    expect(toastMock.error).toHaveBeenCalledWith("paymentMethods.autopayError");
  });
});

describe("«Отвязать» while a payment with the card is being made", () => {
  it("says the payment is in progress instead of «could not unbind»", async () => {
    api.unbindPaymentMethod.mockRejectedValue(BUSY);
    await render();

    await unbindAndConfirm();

    expect(api.unbindPaymentMethod).toHaveBeenCalledWith("pm-1");
    expect(toastMock.error).toHaveBeenCalledWith("paymentMethods.unbindBusy");
    expect(toastMock.error).not.toHaveBeenCalledWith("paymentMethods.error");
  });

  // Only the code says a payment is in progress, not the status: a 409 without
  // it is just another refusal.
  it.each([
    ["any other refusal", refusal(400, { message: "Failed to unbind payment method" })],
    ["a 409 with another code", refusal(409, { code: "SOMETHING_ELSE", message: "Conflict" })],
  ])("keeps saying «could not unbind» for %s", async (_label, error) => {
    api.unbindPaymentMethod.mockRejectedValue(error);
    await render();

    await unbindAndConfirm();

    expect(api.unbindPaymentMethod).toHaveBeenCalledWith("pm-1");
    expect(toastMock.error).toHaveBeenCalledWith("paymentMethods.error");
    expect(toastMock.error).not.toHaveBeenCalledWith("paymentMethods.unbindBusy");
  });
});
