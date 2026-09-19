// @vitest-environment jsdom

/**
 * The install sheet's "Share → Add to Home Screen" branch on an iPad.
 *
 * iPadOS sends a desktop Mac user agent in every browser; only the touch points
 * give it away. The test for that lives in ONE place now
 * (`lib/apple-mobile-device.ts`), shared by web push and by this hook, which
 * used to carry its own copy. These cases hold the hook to it: an iPad in Safari
 * is iOS, a real Mac is not, and a browser that says it is not Safari is still
 * told nothing it cannot do.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useInstallPrompt } from "../src/hooks/use-install-prompt";

const IPAD_SAFARI_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const CHROME_ON_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ onRead }: { onRead: (isIos: boolean) => void }) {
  onRead(useInstallPrompt().isIos);
  return null;
}

function readIsIos(userAgent: string, touchPoints: number): boolean {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => userAgent });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => touchPoints });
  let seen: boolean | null = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Probe onRead={(value) => void (seen = value)} />);
  });
  expect(seen, "the hook never rendered").not.toBeNull();
  return seen as unknown as boolean;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(navigator, "userAgent");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  vi.unstubAllGlobals();
});

describe("useInstallPrompt on iPadOS", () => {
  it("an iPad in Safari, behind a Mac user agent, is offered the Home-Screen steps", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    expect(readIsIos(IPAD_SAFARI_AS_MAC, 5)).toBe(true);
  });

  it("a real Mac with the same user agent is not", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    expect(readIsIos(IPAD_SAFARI_AS_MAC, 0)).toBe(false);
  });

  it("an iPhone in Safari still is, and Chrome on an iPad still is not (it has no Share → Add to Home Screen)", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    expect(readIsIos(IPHONE_SAFARI, 5)).toBe(true);
    if (root) act(() => root?.unmount());
    container?.remove();
    expect(readIsIos(CHROME_ON_IPAD, 5)).toBe(false);
  });
});
