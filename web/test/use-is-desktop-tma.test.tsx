// @vitest-environment jsdom

/**
 * A Mini App never gets the desktop sidebar shell — including on a network that
 * cannot reach telegram.org.
 *
 * `useIsDesktop()` returns true only for a wide viewport that is NOT a Mini App,
 * and `stealth-layout.tsx` picks the shell from it. The Mini App half was read
 * as `Boolean(window.Telegram?.WebApp?.initData)` inside an effect with an EMPTY
 * dependency array — i.e. once, at the single moment the bridge is least likely
 * to exist, because the SDK is still in flight from telegram.org. That is wrong
 * on a healthy network and permanently wrong on a blocked one, and the failure
 * is the one the hook's own doc comment forbids: a desktop sidebar inside a Mini
 * App, whenever the Telegram viewport is also ≥1024px — Telegram Web, or a wide
 * Telegram Desktop window.
 *
 * So `window.Telegram` is defined nowhere below, `matchMedia` reports a desktop
 * viewport throughout, and the hook is executed rather than read as text.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useIsDesktop, DESKTOP_BREAKPOINT_PX } from "@/hooks/use-is-desktop";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let observed: boolean | null = null;

function Probe() {
  observed = useIsDesktop();
  return null;
}

/** Renders the hook and reports what the layout would have been handed. */
function mountProbe(): boolean {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe />);
  });
  return observed ?? false;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/dashboard");
  window.location.hash = "";
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  observed = null;
  // The whole point: the bridge never arrives. telegram.org is unreachable.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  // A wide viewport — Telegram Web, or Telegram Desktop maximised. jsdom has no
  // matchMedia at all, so it has to be supplied either way.
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: query.includes(`min-width: ${DESKTOP_BREAKPOINT_PX}px`),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.sessionStorage.clear();
  __resetTelegramLaunchCaptureForTests();
  vi.unstubAllGlobals();
});

describe("useIsDesktop inside a Mini App with no Telegram SDK", () => {
  it("stays false for a launch carrying tgWebAppData in the URL", () => {
    window.location.hash = `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppPlatform=weba`;

    expect(
      mountProbe(),
      "a Mini App on a ≥1024px viewport was handed the desktop sidebar shell — the hook's own contract says a TMA always feels like the phone app",
    ).toBe(false);
    expect(window.Telegram, "the bridge was defined; this case proves nothing").toBeUndefined();
  });

  it("stays false from the session mirror once the hash is gone", () => {
    // Every cabinet route is reached by a react-router navigation from `/tma` or
    // `/bootstrap`, and that drops the fragment before this hook ever mounts.
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppPlatform: "weba" }),
    );
    expect(window.location.hash).toBe("");

    expect(mountProbe()).toBe(false);
  });

  it("still returns true for a genuine wide browser viewport", () => {
    // The other end: a fix that answered false everywhere would take the desktop
    // shell away from the web cabinet entirely.
    expect(
      mountProbe(),
      "a plain browser at ≥1024px lost the desktop shell — the hook now reports every session as a phone",
    ).toBe(true);
  });
});
