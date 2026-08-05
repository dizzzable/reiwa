// @vitest-environment jsdom

/**
 * A user taps the bot's «Открыть приложение» button. The Mini App opens, shows
 * «Подключение…», and then puts a username/password form in front of a user who
 * has never had a password. Nothing recovers from that screen.
 *
 * The cause was the question, not the clock. Both entry routes decided "Mini
 * App or browser?" by waiting for `telegram.org/js/telegram-web-app.js` and
 * reading `window.Telegram.WebApp.initData` out of it — ~100 KB fetched
 * cross-origin to re-read a value already sitting in `location.hash`, because
 * `initData` IS `tgWebAppData`. This product sells VPN, so the user who tapped
 * that button does not have one yet and telegram.org is exactly the host their
 * network blocks. Failure of that fetch was then spent as "plain browser".
 *
 * Bounding the wait better was the previous attempt and it treated a symptom:
 * a launch whose SDK never arrives at all still has to sign in. So the decision
 * now comes from the URL, and the SDK is a fallback for launch shapes the URL
 * does not carry — chiefly a client-side hop that dropped the hash before the
 * session mirror could be read.
 *
 * These mount the real pages, because the bug was never in the decision
 * function: it was in what the call site let it look at.
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
/** The SDK's own session key; the cabinet mirrors the launch into it. */
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams" as const;

/** A signed Telegram launch payload, i.e. a non-empty `initData`. */
const INIT_DATA = "user=%7B%22id%22%3A42%7D&auth_date=1&hash=deadbeef";

/**
 * The fragment Telegram appends when it opens a Mini App URL — the hash, not
 * the query, which is why it does not survive a react-router navigation.
 *
 * `tgWebAppData` is the launch's `initData`, percent-encoded once. It is in the
 * address bar before a single byte has been requested from telegram.org, which
 * is what lets every case below answer without an SDK.
 */
function withLaunchParameters(): void {
  window.location.hash =
    `#tgWebAppData=${encodeURIComponent(INIT_DATA)}` +
    "&tgWebAppVersion=9.6&tgWebAppPlatform=android";
}

/** The mirror the cabinet (and the SDK) leaves for later documents in the tab. */
function withMirroredLaunchParameters(): void {
  window.sessionStorage.setItem(
    SDK_LAUNCH_PARAMS_KEY,
    JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
  );
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
  // The launch mirror outlives a navigation by design, so it has to be cleared
  // explicitly or a Telegram case would leak its payload into the browser ones.
  window.sessionStorage.clear();
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
  it("routes a Telegram launch to the Mini App from the URL alone, with no SDK at all", async () => {
    withLaunchParameters();
    withSdkState("loading");

    mount(<WebHomePage />);
    // The clock never moves. Anything asserted after this had to be decided
    // with no waiting whatsoever — and there is nothing to wait for: no bridge
    // ever appears, which on the reported connection is the permanent state.
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/sign-in", { replace: true });
    expect(window.Telegram).toBeUndefined();
    expect(api.getSession).not.toHaveBeenCalled();
  });

  it("still reaches the Mini App after the loader reports the SDK cannot be fetched", async () => {
    // The VPN-less launch, exactly: telegram.org is unreachable, the loader's
    // request fails, and `error` is recorded before React mounts. That used to
    // be a final answer of "plain browser" — a password form for a user who has
    // no password. The launch parameters were in the URL the whole time.
    withLaunchParameters();
    withSdkState("error");

    mount(<WebHomePage />);
    await settleWithoutTime();
    await dispatchSdk("error");
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("still reaches the Mini App when the loader recorded ready but no bridge followed", async () => {
    // The loader is a `defer` script in `index.html`, so on a warm cache it can
    // finish before React mounts and the event is long gone. A `ready` with no
    // usable bridge behind it (an intercepted or truncated script that still
    // executed) says nothing about the launch; the URL does.
    withLaunchParameters();
    withSdkState("ready");

    mount(<WebHomePage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("prefers the URL's payload to a bridge reporting an empty initData", async () => {
    // A bridge that came up without launch data is not evidence of a browser
    // when the address bar is holding a signed payload. Believing it here is
    // what turned a partially-initialised SDK into a dead-end login form.
    withLaunchParameters();
    withSdkState("ready");
    withTelegramBridge(null);

    mount(<WebHomePage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/sign-in", { replace: true });
  });

  it("recognises the launch from the session mirror once the hash is gone", async () => {
    // A second document in the same tab — a reload, or the return leg from a
    // payment gateway — has no fragment left. The mirror written on the launch
    // document is what is left of it, and it is enough.
    withMirroredLaunchParameters();
    expect(window.location.hash).toBe("");

    mount(<WebHomePage />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(window.Telegram).toBeUndefined();
  });

  it("keeps waiting past the browser deadline when only the loader's marker is left", async () => {
    // No parameters in the URL and no mirror either (a cold tab, private mode).
    // The loader's marker is then the whole signal, and it still may not be
    // spent on a clock — this is the guard the previous fix added, and the
    // shape it protects is the only one that now depends on the SDK.
    withSdkState("loading");
    expect(window.location.hash).toBe("");

    mount(<WebHomePage />);
    // Well past the 1.5s the page gives a browser.
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
  it("forwards a Telegram launch to the Mini App from the URL alone", async () => {
    withLaunchParameters();
    withSdkState("loading");

    mount(<ContextRouter />);
    await settleWithoutTime();

    expect(navigate).toHaveBeenCalledWith("/tma", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/", { replace: true });
    expect(window.Telegram).toBeUndefined();
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
