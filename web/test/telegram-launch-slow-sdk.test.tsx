// @vitest-environment jsdom

/**
 * A user taps the bot's «Открыть приложение» button on a slow, VPN-proxied
 * link. The Mini App opens, shows «Подключение…» for two seconds, and then
 * puts a username/password form in front of a user who has never had a
 * password. Nothing recovers from that screen.
 *
 * The cause was a clock. Both entry routes had to decide "Mini App or
 * browser?" before the Telegram SDK — fetched from telegram.org, not bundled —
 * had arrived, and both treated running out of time as evidence of "browser".
 * `/` waited a flat 1.5s for every launch; `/bootstrap` did not wait at all.
 * `useTelegramWebApp` had already worked out the rule that avoids this (wait
 * for the loader's explicit `ready`/`error` signal when, and only when, the
 * launch actually came from Telegram) — the entry routes just did not use it.
 *
 * These mount the real pages, because the bug was never in the decision
 * function: it was in how long the call site let it look.
 */

import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  botSignin: vi.fn(),
  getLanding: vi.fn(),
  getSession: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const queryClient = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
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
vi.mock("@/components/ui/brand-logo", () => ({ BrandLogo: () => null }));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", tagline: "" } }),
}));
vi.mock("@/features/landing/landing-page", () => ({ LANDING_QUERY_KEY: ["landing"] }));

import ContextRouter from "../src/features/auth/context-router";
import WebHomePage from "../src/features/auth/web-home-page";

const TELEGRAM = "Telegram" as const;
const SDK_STATE = "__reiwaTelegramSdkState" as const;

/** A signed Telegram launch payload, i.e. a non-empty `initData`. */
const INIT_DATA = "user=%7B%22id%22%3A42%7D&auth_date=1&hash=deadbeef";

/**
 * The fragment Telegram appends when it opens a Mini App URL — the hash, not
 * the query, which is why it does not survive a react-router navigation.
 */
function withLaunchParameters(): void {
  window.location.hash = "#tgWebAppData=payload&tgWebAppVersion=9.6&tgWebAppPlatform=android";
}

/** The loader's marker: stamped for every Telegram launch, even a failing one. */
function withSdkState(state: "loading" | "ready" | "error" | undefined): void {
  if (state === undefined) {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, SDK_STATE);
    return;
  }
  Object.defineProperty(window, SDK_STATE, { value: state, configurable: true, writable: true });
}

/** `null` stands for a bridge that exists but carries no launch payload. */
function withTelegramBridge(initData: string | null): void {
  Object.defineProperty(window, TELEGRAM, {
    value: { WebApp: initData === null ? {} : { initData } },
    configurable: true,
    writable: true,
  });
}

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

/**
 * Drains the pending promise chain while holding the clock at zero, so an
 * assertion made after it can only be satisfied by a decision that needed no
 * time at all — never by a timeout quietly expiring.
 */
async function settleWithoutTime(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

/** Lets the faked clock run, for the cases where elapsing time is the point. */
async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function dispatchSdk(event: "ready" | "error"): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(`reiwa:telegram-sdk-${event}`));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // Full reset, not just the hash: one case below rewrites the path and query.
  window.history.replaceState({}, "", "/");
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, TELEGRAM);
  withSdkState(undefined);
  // No cookie and no published landing: every non-Telegram verdict therefore
  // ends on `/sign-in`, which is the screen the reported bug ended on.
  api.getSession.mockResolvedValue(null);
  queryClient.fetchQuery.mockRejectedValue(new Error("landing unavailable"));
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

describe("WebHomePage launch context", () => {
  it("keeps a Telegram launch waiting past the browser deadline and still routes it to the Mini App", async () => {
    withLaunchParameters();
    withSdkState("loading");

    mount(<WebHomePage />);
    // Well past the 1.5s the page used to give every launch. On the reported
    // connection (~2.7 KB/s over a VPN) the SDK had not arrived by then, and
    // the expired timer was read as "plain browser".
    await elapse(5000);

    expect(navigate).not.toHaveBeenCalled();
    expect(api.getSession).not.toHaveBeenCalled();

    // The SDK finally lands.
    withTelegramBridge(INIT_DATA);
    withSdkState("ready");
    await dispatchSdk("ready");

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("falls through to the web flow as soon as the loader reports the SDK cannot be fetched", async () => {
    withLaunchParameters();
    withSdkState("loading");

    mount(<WebHomePage />);
    await settleWithoutTime();
    expect(navigate).not.toHaveBeenCalled();

    // `error` is an answer, not a delay: no bridge is coming, so the web flow
    // is correct and must not wait for a signal that already arrived.
    withSdkState("error");
    await dispatchSdk("error");
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("takes the already-recorded ready state instead of waiting for an event that will not fire again", async () => {
    // The loader is a `defer` script in `index.html`, so on a warm cache it can
    // finish before React mounts — the event is then long gone and only the
    // recorded state is left. No bridge appeared with it, which is a real
    // answer ("not Telegram after all"), not a reason to keep waiting.
    withLaunchParameters();
    withSdkState("ready");

    mount(<WebHomePage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("still calls an empty initData a browser even when the SDK is present", async () => {
    withLaunchParameters();
    withSdkState("ready");
    withTelegramBridge(null);

    mount(<WebHomePage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/sign-in", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/tma", { replace: true });
  });

  it("gives a launch with no Telegram parameters a bounded wait and lets it expire", async () => {
    // Nothing stamped the loader state, so no signal is ever coming. This is
    // the RU-IP browser that cannot reach telegram.org: it must reach the web
    // flow on its own timer rather than hang on the splash.
    mount(<WebHomePage />);
    await settleWithoutTime();
    expect(navigate).not.toHaveBeenCalled();

    await elapse(2000);

    expect(navigate).toHaveBeenCalledWith("/sign-in", { replace: true });
  });
});

describe("ContextRouter launch context", () => {
  it("waits for the SDK before forwarding, instead of guessing on mount", async () => {
    withLaunchParameters();
    withSdkState("loading");

    mount(<ContextRouter />);
    await settleWithoutTime();
    expect(navigate).not.toHaveBeenCalled();

    withTelegramBridge(INIT_DATA);
    withSdkState("ready");
    await dispatchSdk("ready");

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
  });

  it("recognises a Telegram launch that arrived here through a client-side hop", async () => {
    // `/bootstrap` is reached by `<Navigate>` from StealthLayout, logout, claim
    // and finish-setup — and react-router drops the hash, taking Telegram's
    // launch parameters with it. The loader's state marker is what is left of
    // them, and it is stamped only for launches that had them.
    withSdkState("loading");
    expect(window.location.hash).toBe("");

    mount(<ContextRouter />);
    await settleWithoutTime();
    expect(navigate).not.toHaveBeenCalled();

    withTelegramBridge(INIT_DATA);
    withSdkState("ready");
    await dispatchSdk("ready");

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
  });

  it("forwards a plain browser to the web home with no wait at all", async () => {
    // Logout lands here, and this route renders nothing — any wait would be a
    // blank screen. The page it forwards to runs the bounded wait itself.
    mount(<ContextRouter />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("keeps the deep-link destination across the wait", async () => {
    withSdkState("loading");
    window.history.replaceState({}, "", "/bootstrap?next=%2Frenew");

    mount(<ContextRouter />);
    withTelegramBridge(INIT_DATA);
    withSdkState("ready");
    await dispatchSdk("ready");

    expect(navigate).toHaveBeenCalledWith("/tma?next=%2Frenew", { replace: true });
  });
});
