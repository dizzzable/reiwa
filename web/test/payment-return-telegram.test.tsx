// @vitest-environment jsdom

/**
 * `/payment-return/telegram` — the cabinet's own page between a gateway and the
 * bot, for a buyer who paid from the Mini App.
 *
 * The gateway used to redirect such a buyer to `t.me/<bot>?start=payment_return`
 * itself. On Android its page runs in Telegram's in-app browser, which loaded
 * that redirect as a t.me web page whose script then went to `tg:resolve?…` —
 * net::ERR_UNKNOWN_URL_SCHEME, «Не удалось открыть веб-страницу», after a
 * payment that went through (WATA, 0.9.7.71).
 *
 * What holds the fix here: the page offers the same deep link as an ordinary
 * same-window anchor (a tap, which Telegram's in-app browser resolves inside
 * the app), never navigates anywhere by itself, and claims nothing about the
 * payment — the gateway lands here on success and failure alike.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const branding = vi.hoisted(() => ({ botUsername: "RezeisBot" as string | null }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ botUsername: branding.botUsername }),
}));

import PaymentReturnTelegramPage from "../src/features/payment/payment-return-telegram-page";
import { telegramPaymentReturnLink } from "../src/lib/telegram-payment-return";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<PaymentReturnTelegramPage />);
  });
  return container;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  branding.botUsername = "RezeisBot";
  window.history.replaceState({}, "", "/payment-return/telegram");
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("the page a Mini App buyer comes back to from the gateway", () => {
  it("offers the bot's payment_return link as a same-window tap", () => {
    const page = mount();
    const link = page.querySelector<HTMLAnchorElement>("[data-payment-return-telegram-link]");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://t.me/RezeisBot?start=payment_return");
    // A new window is a pop-up Telegram's in-app browser hands elsewhere; the
    // tap has to be a navigation of this very page.
    expect(link?.getAttribute("target")).toBeNull();
    expect(page.textContent).toContain("paymentAnim.backToTelegramTitle");
    expect(page.textContent).toContain("paymentAnim.backToTelegramButton");
    expect(page.textContent).toContain("paymentAnim.backToTelegramClose");
    expect(page.textContent).not.toContain("paymentAnim.backToTelegramCloseOnly");
  });

  it("does not leave by itself — a redirect from here is the redirect that failed", () => {
    mount();
    expect(window.location.pathname).toBe("/payment-return/telegram");
  });

  it("says neither paid nor failed: the gateway lands here on both", () => {
    const text = mount().textContent ?? "";
    expect(text).not.toContain("paymentAnim.success");
    expect(text).not.toContain("paymentAnim.failed");
  });

  it("puts nothing behind a button when the cabinet names no bot, and still says what to do", () => {
    branding.botUsername = null;
    const page = mount();
    expect(page.querySelector("[data-payment-return-telegram-link]")).toBeNull();
    // …and does not speak of a button it does not show.
    expect(page.textContent).toContain("paymentAnim.backToTelegramCloseOnly");
  });
});

describe("telegramPaymentReturnLink", () => {
  it("builds the deep link from a username, with or without its @", () => {
    expect(telegramPaymentReturnLink("RezeisBot")).toBe("https://t.me/RezeisBot?start=payment_return");
    expect(telegramPaymentReturnLink("@RezeisBot")).toBe("https://t.me/RezeisBot?start=payment_return");
  });

  it("refuses anything that is not a Telegram username", () => {
    expect(telegramPaymentReturnLink(null)).toBeNull();
    expect(telegramPaymentReturnLink("")).toBeNull();
    expect(telegramPaymentReturnLink("evil.example/x")).toBeNull();
    expect(telegramPaymentReturnLink("bot?start=x")).toBeNull();
    expect(telegramPaymentReturnLink("abc")).toBeNull();
  });
});
