// @vitest-environment jsdom

/**
 * ONE TAP ON «ПОДКЛЮЧИТЬ» IS ONE OPEN.
 *
 * The button used to do the work twice. Its own `onClick` opened the
 * subscription URL and fired a haptic, and then called `onConnect` — which the
 * dashboard page implements by opening the SAME url off the SAME
 * `activeSubscription` and firing a second haptic. Two opens, two haptics, per
 * tap.
 *
 * Nobody saw it, and that is the whole reason it survived: inside Telegram the
 * second `openLink` lands while the first is still opening and the client
 * swallows it, and in a browser the stray second `window.open("_blank")` is
 * either eaten by the pop-up blocker or lands underneath the first, identical
 * tab. "I pressed it once and it worked" was true the entire time.
 *
 * So this test does not ask whether something opened. It asks WHO opened it:
 * the button raises the intent and opens nothing itself. That is also what
 * makes the coming "inside the cabinet instead of an external page" switch a
 * one-place change — the page owns what connecting means, and the button has no
 * second opinion about it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Subscription } from "../src/types/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { addOns: [] } }),
}));
vi.mock("@/lib/api-client", () => ({ getSubscriptionAddOns: vi.fn() }));

const { SubscriptionActions } = await import(
  "../src/features/dashboard/components/subscription-actions"
);

const subscription = {
  id: "sub-1",
  status: "ACTIVE",
  isTrial: false,
  url: "https://sub.example.test/abc",
} as unknown as Subscription;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function renderActions(onConnect: () => void): HTMLButtonElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <SubscriptionActions
        subscription={subscription}
        onConnect={onConnect}
        onUpgrade={() => undefined}
        onRenew={() => undefined}
      />,
    );
  });
  // The connect action is the first button in the row.
  const button = host.querySelector("button");
  if (button === null) throw new Error("connect button did not render");
  return button as HTMLButtonElement;
}

describe("the connect action", () => {
  it("opens nothing itself and raises the intent exactly once", () => {
    // `openExternalUrl` falls back to `window.open` outside Telegram, so a spy
    // here sees any opening the BUTTON does on its own. Before the fix this
    // caught one call; the parent's own open is out of this component's scope
    // and is not exercised here.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const onConnect = vi.fn();

    const button = renderActions(onConnect);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("stays disabled while the subscription has no link to open", () => {
    // The guard belongs to the button because it is about what the button can
    // offer, not about what connecting means.
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SubscriptionActions
          subscription={{ ...subscription, url: null } as unknown as Subscription}
          onConnect={() => undefined}
          onUpgrade={() => undefined}
          onRenew={() => undefined}
        />,
      );
    });

    const button = host.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });
});
