// @vitest-environment jsdom

/**
 * The cabinet must be able to reach its operator identity on a client that
 * never tells it the document is visible.
 *
 * This is the state behind "the operator applied a theme and iOS still shows
 * stock Reiwa". BOTH carriers have to be empty for that to happen — no stored
 * snapshot AND no fetched payload — and a Telegram Mini App on iPhone is the
 * one surface where both routinely are: there is no Service Worker in that
 * WebView at all, `/api/v1/public-config` is deliberately not service-worker
 * cached anyway (`web/src/sw-cache-policy.ts`), and a first launch has nothing
 * in `localStorage`. The whole identity of that session therefore rides on one
 * HTTP request, issued while the customer's VPN is not up yet.
 *
 * Everything that was supposed to happen after that request is lost went
 * through one platform signal, `document.visibilityState`:
 *
 *   - React Query's retryer sleeps and then asks `canContinue()`, which begins
 *     `focusManager.isFocused()` — `document.visibilityState !== "hidden"`. On
 *     `hidden` the query does not fail, it PARKS in `fetchStatus: "paused"`,
 *     and a parked query answers every later `fetch()` with the same dead
 *     promise. `status` stays `pending`, so the cabinet cannot even report it.
 *   - the 15s poll, because `refetchIntervalInBackground: false` makes the tick
 *     `if (... || focusManager.isFocused())`;
 *   - the return listener, because it was bound to `visibilitychange` alone.
 *
 * These cases therefore hold `visibilityState` at `"hidden"` for their whole
 * length and never dispatch a `visibilitychange`. They assert the FALLBACK
 * PATH — that the operator palette reaches the document anyway — and not that
 * any particular function was called.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getReiwaPublicConfig: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "ru", changeLanguage: vi.fn().mockResolvedValue(undefined) },
  }),
}));
// The iOS Mini App case exactly: storage carries nothing, so the built-in
// identity is what the cabinet paints until the network answers.
vi.mock("@/lib/public-config-snapshot", () => ({
  readPublicConfigSnapshot: () => null,
  writePublicConfigSnapshot: vi.fn(),
}));
vi.mock("@/lib/client-error-reporter", () => ({ reportClientError: vi.fn() }));

import { BrandingProvider } from "@/lib/branding-provider";
import { DEFAULT_PUBLIC_CONFIG, type PublicConfig } from "@/types/branding";

const OPERATOR_PRIMARY = "#6750a4";
const BUILT_IN_PRIMARY = DEFAULT_PUBLIC_CONFIG.branding.primary;

const OPERATOR_CONFIG: PublicConfig = {
  ...DEFAULT_PUBLIC_CONFIG,
  branding: {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Northern Lights",
    primary: OPERATOR_PRIMARY,
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

/** The platform never reports the document visible, and never says it changed. */
function withDocumentNeverVisible(): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
}

/** The cold-launch request is lost; every later one answers normally. */
function withFirstRequestLost(): void {
  let attempts = 0;
  api.getReiwaPublicConfig.mockImplementation(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network unreachable");
    return OPERATOR_CONFIG;
  });
}

function mount(children: ReactNode = null): void {
  client = new QueryClient();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client!}>
        <BrandingProvider>{children}</BrandingProvider>
      </QueryClientProvider>,
    );
  });
}

/**
 * Move the clock, then settle.
 *
 * The settling passes are SEPARATE `act` boundaries on purpose: React commits
 * its pending work when one exits, and a query result has to travel through
 * the observer's batched notification before that work exists at all. Draining
 * inside a single `act` leaves the re-render for after the assertion.
 */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let pass = 0; pass < 4; pass += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

function paintedPrimary(): string {
  return document.documentElement.style.getPropertyValue("--brand-primary");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  document.documentElement.removeAttribute("style");
  window.localStorage.clear();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  client?.clear();
  client = null;
  Reflect.deleteProperty(document, "visibilityState");
  document.documentElement.removeAttribute("style");
  api.getReiwaPublicConfig.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bootstrap recovery on a client that never reports the document visible", () => {
  it("reaches the operator palette after the launch request is lost", async () => {
    withDocumentNeverVisible();
    withFirstRequestLost();

    mount();

    await elapse(1_000);
    expect(
      paintedPrimary(),
      "precondition: the launch request was supposed to be lost and leave the built-in identity on screen",
    ).toBe(BUILT_IN_PRIMARY);

    // One cadence of the retry poll, with the platform still saying `hidden`.
    await elapse(20_000);

    expect(
      paintedPrimary(),
      "the cabinet never re-asked for its operator configuration: one lost request parks the query behind a visibility signal this platform does not give, so a Mini App launch keeps painting stock Reiwa for the whole session",
    ).toBe(OPERATOR_PRIMARY);
  });

  it("treats a thawed document as a return even though no visibilitychange fires", async () => {
    withDocumentNeverVisible();
    withFirstRequestLost();

    mount();
    await elapse(1_000);
    expect(paintedPrimary()).toBe(BUILT_IN_PRIMARY);

    // A frozen document being presented again. WebKit fires this and NOT
    // `visibilitychange` — the document never became hidden, it stopped
    // existing and started again. Well inside the 15s poll cadence, so this
    // event is the only thing that can rescue the palette here.
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await elapse(0);

    expect(
      paintedPrimary(),
      "a Mini App returning from the frozen state did not re-read its configuration: the recovery listens only for `visibilitychange`, which that return does not fire",
    ).toBe(OPERATOR_PRIMARY);
  });

  it("stops asking once the operator payload has landed", async () => {
    withDocumentNeverVisible();
    api.getReiwaPublicConfig.mockResolvedValue(OPERATOR_CONFIG);

    mount();
    await elapse(1_000);
    expect(paintedPrimary()).toBe(OPERATOR_PRIMARY);

    const afterFirstPayload = api.getReiwaPublicConfig.mock.calls.length;
    await elapse(120_000);

    expect(
      api.getReiwaPublicConfig.mock.calls.length,
      "the recovery poll is meant to be self-terminating: once a real payload is in the cache it must stop, not become a permanent request every 15 seconds on every hidden document",
    ).toBe(afterFirstPayload);
  });
});
