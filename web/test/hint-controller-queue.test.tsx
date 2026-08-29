// @vitest-environment jsdom

/**
 * The queue must survive the hints it does not draw.
 *
 * Two ways this controller silently destroyed a customer's queue, both found in
 * final review and both invisible from the outside — the modal that DID appear
 * looked perfectly correct in each case.
 *
 * 1. A hint arriving while a modal was open was thrown away by the state
 *    updater and then stamped SHOWN anyway. `nextFor` filters on `shownAt:
 *    null`, so that delivery became permanently invisible: never drawn, never
 *    re-offered, and — because the flagship hint is non-repeatable — never
 *    raised again either. The purchase hint died exactly this way, since buying
 *    is the one thing that queues a hint mid-visit.
 *
 * 2. A hint in a mode this build cannot draw was skipped without being closed,
 *    so it stayed at the head of an ascending-`createdAt` queue and blocked
 *    every later hint for up to ninety days.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getNextHint: vi.fn(),
  markHintShown: vi.fn(async () => true),
  closeHint: vi.fn(async () => true),
  reportHintMoment: vi.fn(async () => false),
}));

vi.mock("@/lib/api-client/hints", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));

import { HintController } from "@/features/hints/hint-controller";

const AUDIENCE = { surface: "browser", formFactor: "desktop", os: "linux" } as never;

function hint(over: Record<string, unknown> = {}) {
  return {
    deliveryId: "d1",
    key: "k1",
    mode: "MODAL",
    tone: "INFO",
    title: "T",
    body: "B",
    ctaKind: "NONE",
    ctaLabel: null,
    ctaTarget: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<HintController audience={AUDIENCE} />);
  });
}

describe("a hint the controller does not draw", () => {
  it("is not stamped shown when a modal is already open", async () => {
    // First ask wins the screen; the second arrives while it is still up.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d1" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d2", key: "subscription-ready" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    expect(api.markHintShown).toHaveBeenCalledWith("d1");

    // The purchase completes while the first modal is still on screen.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
    });

    // d2 was not drawn, so it MUST NOT be stamped. Stamping it here is what
    // made the flagship hint unreachable for ever.
    expect(api.markHintShown).not.toHaveBeenCalledWith("d2");
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });

  it("closes a mode it cannot render instead of leaving it at the head of the queue", async () => {
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" }));

    await render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Closed, not skipped: skipping left it first in line for its whole TTL and
    // starved every hint behind it, a failed-payment one included.
    expect(api.closeHint).toHaveBeenCalledWith("d-toast", "dismissed");
    // …and the queue moved on rather than stopping there.
    expect(api.getNextHint).toHaveBeenCalledTimes(2);
    expect(api.markHintShown).toHaveBeenCalledWith("d-modal");
  });

  it("stamps exactly once for the hint it does draw", async () => {
    // StrictMode double-invokes updaters and replays discarded renders, so a
    // side effect placed inside one fires more than once per hint.
    api.getNextHint.mockResolvedValue(hint({ deliveryId: "d1" }));
    await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });
});
