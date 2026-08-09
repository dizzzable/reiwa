// @vitest-environment jsdom

/**
 * `/tma` signs the launch in without the Telegram SDK, and without a clock.
 *
 * `initData` IS `tgWebAppData`: Telegram puts it in the launch document's
 * address bar before a byte is requested from telegram.org. This product sells
 * VPN, so the customer tapping the bot's button has none yet and telegram.org
 * is exactly the host their network blocks — every failure of that fetch used
 * to be spent as "plain browser", i.e. a password form for someone who has
 * never had a password.
 *
 * This page had no behavioural test at all: `telegram-webapp-launch-policy.test.ts`
 * only grepped its source. So every case below mounts the real page, defines
 * `window.Telegram` NOWHERE, and (except where elapsing time is the point)
 * holds the clock at zero — anything that passes was decided from the URL.
 *
 * The last two cases are the entry-probe guard, executing rather than grepped:
 * `fetchSessionOrNull` converts a failed `/api/v1/session` into a successful
 * `null`, so the probe cannot tell "no session" from "could not ask". On this
 * page that must stay harmless, because both answers mean "bootstrap" — which
 * is the sign-in. A probe failure must never become an error screen or a form.
 */

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bootstrapTelegram: vi.fn(),
  getSession: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  setQueryData: vi.fn(),
  fetchQuery: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClient,
  useQuery: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("motion/react", () => ({
  motion: { div: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/components/ui/entry-brand-tile", () => ({ EntryBrandTile: () => null }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", tagline: "" } }),
}));
vi.mock("@/lib/client-error-reporter", () => ({ reportClientError: vi.fn() }));

import BootstrapPage from "@/features/auth/tma-bootstrap-page";
import { __resetTelegramWebAppBridgeForTests } from "@/hooks/use-telegram-webapp";
import { __resetTelegramLaunchCaptureForTests } from "@/lib/telegram-launch-params";

/**
 * `auth_date` is NOW, not 1970.
 *
 * The cabinet refuses to replay a CARRIED payload past the server's own 24h
 * window (`telegram-launch-params.ts`, `isSpentLaunchPayload`) — the server
 * would answer it 401 and the error screen's Retry would reload into the same
 * 401 forever. A fixture stamped 1970 is exactly that dead payload, so every
 * mirror/memory case below would be asserting on a launch the product is right
 * to drop. This says what the fixture always claimed to be: a live launch.
 */
const LAUNCH_AUTH_DATE = Math.floor(Date.now() / 1000);
const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${LAUNCH_AUTH_DATE}&hash=deadbeef`;
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(page: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(page);
  });
}

/** Drains the promise chain with the clock pinned at zero. */
async function settleWithoutTime(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

function withLaunchHash(): void {
  window.location.hash =
    `#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6&tgWebAppPlatform=ios`;
}

function withMirroredLaunch(): void {
  window.sessionStorage.setItem(
    SDK_LAUNCH_PARAMS_KEY,
    JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/tma");
  window.location.hash = "";
  window.sessionStorage.clear();
  // The module-level launch capture survives client-side navigation by design
  // and therefore leaks between cases and between spec files.
  __resetTelegramLaunchCaptureForTests();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "__reiwaTelegramSdkState");
  queryClient.fetchQuery.mockResolvedValue(null);
  api.bootstrapTelegram.mockResolvedValue({ ok: true, redirectUrl: "/dashboard" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  __resetTelegramWebAppBridgeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("TmaBootstrapPage — auto-login with no Telegram SDK", () => {
  it("bootstraps from the launch fragment, with no bridge and no clock", async () => {
    withLaunchHash();
    Object.defineProperty(window, "__reiwaTelegramSdkState", {
      value: "loading",
      configurable: true,
      writable: true,
    });

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(
      api.bootstrapTelegram,
      "the Mini App did not sign in from the payload already in the address bar — it is waiting on telegram.org, the one host these customers cannot reach",
    ).toHaveBeenCalledWith(INIT_DATA);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(window.Telegram).toBeUndefined();
  });

  it("bootstraps from the session mirror once the fragment is gone", async () => {
    // A second document in the tab: a reload, the return leg from a payment
    // gateway, or any client-side hop. The mirror is all that is left.
    withMirroredLaunch();
    expect(window.location.hash).toBe("");

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(api.bootstrapTelegram).toHaveBeenCalledWith(INIT_DATA);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });

  it("honours a deep-link destination carried across the hand-off", async () => {
    window.history.replaceState({}, "", "/tma?next=%2Frenew");
    withLaunchHash();

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/renew", { replace: true });
  });

  it("skips the bootstrap when the cookie is still live", async () => {
    withLaunchHash();
    queryClient.fetchQuery.mockResolvedValue({ userId: 42, telegramId: "42" });

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
    expect(api.bootstrapTelegram).not.toHaveBeenCalled();
  });

  // ── Entry-probe guard, executing ───────────────────────────────────────────

  it("still signs in when the session probe RESOLVES null because it failed", async () => {
    // `fetchSessionOrNull` swallows the network error and returns null, so this
    // is indistinguishable from "no session" — and must stay that way, because
    // on this page both answers mean "bootstrap".
    withLaunchHash();
    queryClient.fetchQuery.mockResolvedValue(null);

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(api.bootstrapTelegram).toHaveBeenCalledWith(INIT_DATA);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });

  it("still signs in when the session probe REJECTS outright", async () => {
    // A `cancelQueries` elsewhere rejects `fetchQuery` with a CancelledError.
    // That must reach the bootstrap, not the outer catch's error screen.
    withLaunchHash();
    queryClient.fetchQuery.mockRejectedValue(new Error("CancelledError"));

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(
      api.bootstrapTelegram,
      "a rejected session probe fell through to the error screen instead of the initData bootstrap",
    ).toHaveBeenCalledWith(INIT_DATA);
    expect(navigate).toHaveBeenCalledWith("/dashboard", { replace: true });
  });
});

/**
 * The error screen's only affordance is Retry, and Retry is
 * `window.location.reload()`.
 *
 * A reload is a NEW document that reads the session mirror back AND keeps the
 * fragment — so a payload the server has refused is sent again, refused again,
 * and the user is in a loop with no way out of the screen. The refusal has to
 * take the payload with it.
 */
describe("a payload the server refuses is not left to be replayed", () => {
  /** An axios rejection shaped like the BFF's `401 Authentication failed`. */
  function refuse(status: number): Error & { response: { status: number; data: unknown } } {
    return Object.assign(new Error("request failed"), {
      response: { status, data: { message: "Authentication failed" } },
    });
  }

  it("drops it from the URL and the mirror after a 401", async () => {
    withLaunchHash();
    withMirroredLaunch();
    api.bootstrapTelegram.mockRejectedValue(refuse(401));

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(api.bootstrapTelegram).toHaveBeenCalledWith(INIT_DATA);
    expect(
      window.location.hash,
      "the refused payload is still in the address bar — Retry reloads and replays it, and the 401 loop is permanent",
    ).not.toContain("tgWebAppData");
    const stored = JSON.parse(window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY) ?? "null");
    expect(
      stored?.tgWebAppData,
      "the refused payload is still in the session mirror, which a reload reads before anything else",
    ).toBeUndefined();
  });

  it("keeps it for a failure that is going to clear on its own", async () => {
    // 502/503 and transport failures say nothing about the payload. Discarding a
    // good launch for a transient upstream outage would cost the sign-in for a
    // reason that was about to fix itself — and the user cannot re-launch from
    // inside the Mini App.
    withLaunchHash();
    withMirroredLaunch();
    api.bootstrapTelegram.mockRejectedValue(refuse(503));

    mount(<BootstrapPage />);
    await settleWithoutTime();

    expect(window.location.hash).toContain("tgWebAppData");
    const stored = JSON.parse(window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY) ?? "null");
    expect(stored?.tgWebAppData).toBe(INIT_DATA);
  });
});
