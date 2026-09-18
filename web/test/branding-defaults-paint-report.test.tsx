// @vitest-environment jsdom

/**
 * When the operator is told their cabinet showed stock Reiwa.
 *
 * `BrandingProvider` reports one state the cabinet cannot present honestly: the
 * bootstrap failed AND nothing is stored, so the customer is looking at the
 * built-in identity — stock palette, the name `Reiwa`, the fallback navigation
 * — on a screen that otherwise works perfectly. That report carries the user
 * agent and reaches the operator's event feed and Telegram.
 *
 * It used to fire on the FIRST failed attempt. The bootstrap's only retry is
 * the 15s poll, so a carrier hiccup on a launch that has not reached the VPN
 * yet — ordinary on a phone — was recovered on the next tick and had already
 * been reported as an ERROR. Production, 18.09.2026, 01:27: one iPhone on
 * Safari, one alert, nothing for the operator to do.
 *
 * So the report waits out the window in `DEFAULTS_PAINT_REPORT_AFTER_MS` and is
 * cancelled outright the moment a payload lands. These cases pin both halves:
 * a blip stays silent, a client that cannot read the configuration at all is
 * still reported, exactly once.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getReiwaPublicConfig: vi.fn() }));
const reporter = vi.hoisted(() => ({ reportClientError: vi.fn() }));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "ru", changeLanguage: vi.fn().mockResolvedValue(undefined) },
  }),
}));
// Nothing stored: the phone's first launch, which is the only way both carriers
// are empty at once.
vi.mock("@/lib/public-config-snapshot", () => ({
  readPublicConfigSnapshot: () => null,
  writePublicConfigSnapshot: vi.fn(),
}));
vi.mock("@/lib/client-error-reporter", () => reporter);

import { BrandingProvider } from "@/lib/branding-provider";
import {
  DEFAULTS_PAINT_MESSAGE,
  DEFAULTS_PAINT_REPORT_AFTER_MS,
  PUBLIC_CONFIG_RETRY_INTERVAL_MS,
} from "@/lib/branding-provider-policy";
import { DEFAULT_PUBLIC_CONFIG, type PublicConfig } from "@/types/branding";

const OPERATOR_CONFIG: PublicConfig = {
  ...DEFAULT_PUBLIC_CONFIG,
  branding: {
    ...DEFAULT_PUBLIC_CONFIG.branding,
    brandName: "Northern Lights",
    primary: "#6750a4",
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient | null = null;

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

/** Move the clock, then let React commit what the answer produced. */
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

function paintReports(): unknown[] {
  return reporter.reportClientError.mock.calls
    .map(([input]) => input as { kind?: string })
    .filter((input) => input.kind === "branding.defaults-painted");
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
  document.documentElement.removeAttribute("style");
  api.getReiwaPublicConfig.mockReset();
  reporter.reportClientError.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the cabinet painting its built-in identity", () => {
  it("says nothing when the poll gets the configuration after a lost launch request", async () => {
    let attempts = 0;
    api.getReiwaPublicConfig.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network unreachable");
      return OPERATOR_CONFIG;
    });

    mount();
    await elapse(1_000);
    expect(
      document.documentElement.style.getPropertyValue("--brand-primary"),
      "precondition: the launch request was supposed to fail and leave the built-in identity up",
    ).toBe(DEFAULT_PUBLIC_CONFIG.branding.primary);

    // The poll recovers long before the window is out...
    await elapse(PUBLIC_CONFIG_RETRY_INTERVAL_MS + 1_000);
    expect(document.documentElement.style.getPropertyValue("--brand-primary")).toBe("#6750a4");

    // ...and nothing is sent, then or later.
    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS * 2);
    expect(
      paintReports(),
      "a hiccup the cabinet recovered from on its own woke the operator with an ERROR",
    ).toEqual([]);
  });

  it("reports once, with what it waited, when every attempt fails", async () => {
    api.getReiwaPublicConfig.mockRejectedValue(new Error("network unreachable"));

    mount();
    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS - 1_000);
    expect(
      paintReports(),
      "reported before the window was out — a blip would be reported as an outage",
    ).toEqual([]);

    await elapse(2_000);

    expect(paintReports()).toHaveLength(1);
    expect(paintReports()[0]).toEqual({
      message: DEFAULTS_PAINT_MESSAGE,
      kind: "branding.defaults-painted",
    });
    expect(DEFAULTS_PAINT_MESSAGE).toContain("45s");

    // One per session, however long the outage lasts.
    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS * 3);
    expect(paintReports()).toHaveLength(1);
  });

  it("says nothing about a customer who closed the cabinet before the window was out", async () => {
    api.getReiwaPublicConfig.mockRejectedValue(new Error("network unreachable"));

    mount();
    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS - 1_000);
    act(() => root?.unmount());
    root = null;

    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS * 2);

    expect(paintReports()).toEqual([]);
  });

  it("says nothing while the request is merely slow, however long it takes", async () => {
    // A request that never settles is not a failure: the cabinet is painting
    // the built-in identity as its ordinary FIRST PAINT, with an answer still
    // on its way. Reporting that would tell the operator their configuration
    // is unreachable every time a phone is slow.
    api.getReiwaPublicConfig.mockImplementation(() => new Promise(() => {}));

    mount();
    await elapse(DEFAULTS_PAINT_REPORT_AFTER_MS * 3);

    expect(
      document.documentElement.style.getPropertyValue("--brand-primary"),
      "precondition: a request in flight is supposed to leave the built-in identity on screen",
    ).toBe(DEFAULT_PUBLIC_CONFIG.branding.primary);
    expect(paintReports()).toEqual([]);
  });

  it("waits longer than two polls, so the window can only pass after the poll has failed again", () => {
    // ANTI-VACUITY for the window itself: a value under one poll interval would
    // report exactly the blip these cases exist to keep quiet, and every test
    // above would still pass.
    expect(DEFAULTS_PAINT_REPORT_AFTER_MS).toBeGreaterThan(PUBLIC_CONFIG_RETRY_INTERVAL_MS * 2);
  });
});
