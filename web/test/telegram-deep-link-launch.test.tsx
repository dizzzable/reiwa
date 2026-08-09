// @vitest-environment jsdom

/**
 * A Mini App launched STRAIGHT ONTO A CABINET ROUTE must still auto-login.
 *
 * The bot does not only open the cabinet at `/`. Notification and keyboard
 * buttons are `web_app` buttons built as `${miniAppUrl}${path}` —
 * `src/bot/listeners/internal-http-listener.ts:329` ("Mini App deep-link button
 * — opens the cabinet straight on a route") and
 * `src/bot/widgets/main-keyboard.ts:355`. So a real launch document can be
 * `/renew#tgWebAppData=…`, `/plans#…`, `/subscription#…`.
 *
 * Every one of those paths is behind `<StealthLayout>`, and StealthLayout's
 * first act on a cookieless document is
 * `<Navigate to={`/bootstrap${next}`} replace />`. That is a react-router
 * navigation, and it DROPS THE FRAGMENT — taking `tgWebAppData` with it.
 *
 * The fragment survives in the in-memory capture and the SDK's session mirror
 * (`__telegram__initParams`), both written by `resolveTelegramLaunchParams()`,
 * which `web/src/main.tsx` calls at module scope before React renders anything.
 * It used to be reached only from the four entry screens — `/`, `/tma`,
 * `/bootstrap`, `/claim` — none of which mounts on a protected route, so on a
 * deep-link launch nothing had captured the payload by the time StealthLayout
 * discarded it and the launch was spent: `/bootstrap` found no parameters, fell
 * back to waiting for telegram.org — the one host this product's customers
 * cannot reach — and ended on `/sign-in`, asking a subscriber with a linked
 * account for a password.
 *
 * WHERE the capture runs, and that it beats a real `<Navigate>` rendered on the
 * first render, is pinned by `web/test/telegram-launch-capture-order.test.tsx`,
 * which imports the real `main.tsx` and lets the two race. This file is about
 * what happens AFTER: the delivery shapes the capture has to cover, and the
 * routing on the far side of the navigation that dropped the URL copy. So
 * `entryChunkRuns()` below stands in for that module-scope call.
 *
 * Every case defines `window.Telegram` NOWHERE.
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
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ branding: { brandName: "Reiwa", tagline: "" } }),
}));
vi.mock("@/lib/client-error-reporter", () => ({ reportClientError: vi.fn() }));
vi.mock("@/features/landing/landing-page", () => ({ LANDING_QUERY_KEY: ["landing"] }));

import ContextRouter from "@/features/auth/context-router";
import { __resetTelegramWebAppBridgeForTests } from "@/hooks/use-telegram-webapp";
import {
  readTelegramLaunchInitData,
  resolveTelegramLaunchParams,
  __resetTelegramLaunchCaptureForTests,
} from "@/lib/telegram-launch-params";

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

/**
 * The entry chunk executing on the launch document.
 *
 * `web/src/main.tsx` calls exactly this at module scope, before
 * `createRoot(root).render(…)` — no route, no component and no effect involved,
 * which is the point and is why the routes below need not mount anything to
 * have the payload. That the placement really is early enough to beat a
 * `<Navigate>` is proved in `telegram-launch-capture-order.test.tsx` against the
 * real `main.tsx`; here it is a precondition.
 */
function entryChunkRuns(): void {
  resolveTelegramLaunchParams();
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: ReactElement): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

async function settleWithoutTime(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Telegram opens the deep-link document: the bot's `web_app` button URL plus
 * the launch fragment. The loader stamps its marker because the parameters are
 * present, then its request to telegram.org is blocked.
 */
function launchDeepLinkDocument(path: string): void {
  window.history.replaceState(
    {},
    "",
    `${path}#tgWebAppData=${encodeURIComponent(INIT_DATA)}` +
      "&tgWebAppVersion=9.6&tgWebAppPlatform=ios",
  );
  Object.defineProperty(window, "__reiwaTelegramSdkState", {
    value: "loading",
    configurable: true,
    writable: true,
  });
}

/** StealthLayout's cookieless redirect, verbatim in effect: the hash is gone. */
function stealthLayoutRedirectsToBootstrap(intended: string): void {
  window.history.replaceState({}, "", `/bootstrap?next=${encodeURIComponent(intended)}`);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  window.history.replaceState({}, "", "/");
  window.location.hash = "";
  window.sessionStorage.clear();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "__reiwaTelegramSdkState");
  api.getSession.mockResolvedValue(null);
  queryClient.fetchQuery.mockRejectedValue(new Error("landing unavailable"));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  __resetTelegramWebAppBridgeForTests();
  __resetTelegramLaunchCaptureForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Mini App deep-link launch onto a protected route", () => {
  it("mirrors the launch parameters before any navigation can drop them", () => {
    // The document Telegram opened is `/renew#tgWebAppData=…`. Nothing on that
    // route reads the launch — the four entry screens are elsewhere — so unless
    // the entry chunk itself captures, the only copy of the payload is a
    // fragment that StealthLayout is about to discard.
    launchDeepLinkDocument("/renew");

    entryChunkRuns();

    expect(
      window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY),
      "the launch payload was never mirrored on a protected-route launch document — the fragment is the only copy, and StealthLayout's <Navigate to='/bootstrap'> is about to drop it",
    ).not.toBeNull();
  });

  it("still reaches the Mini App after StealthLayout has dropped the fragment", async () => {
    launchDeepLinkDocument("/renew");
    entryChunkRuns();

    // Cookieless: `<Navigate to="/bootstrap?next=%2Frenew" replace />`.
    stealthLayoutRedirectsToBootstrap("/renew");
    expect(window.location.hash).toBe("");

    mount(<ContextRouter />);
    await settleWithoutTime();
    // telegram.org is blocked, so the loader's request finally fails. Before
    // this fix that error WAS the answer, and the answer was "plain browser".
    await act(async () => {
      window.dispatchEvent(new Event("reiwa:telegram-sdk-error"));
      await vi.advanceTimersByTimeAsync(0);
    });
    await elapse(2000);

    expect(
      navigate,
      "a Mini App deep-link launch was routed to the web flow — the subscriber who tapped «Продлить» in the bot lands on a password form",
    ).toHaveBeenCalledWith("/tma?next=%2Frenew", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith("/?next=%2Frenew", { replace: true });
    expect(window.Telegram).toBeUndefined();
  });
});

/**
 * The delivery shapes Telegram actually uses, each asserted on the same
 * deep-link document. `urlParameterSources()` reads the fragment AND the query
 * precisely because both are real; the capture must therefore cover both, or
 * the clients that use the one it misses stay broken after the fix.
 */
describe("launch delivery shapes", () => {
  /** Current native clients — iOS, Android, Telegram Desktop: fragment. */
  it("captures a fragment-delivered launch", () => {
    window.history.replaceState(
      {},
      "",
      `/renew#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppPlatform=tdesktop`,
    );

    entryChunkRuns();
    stealthLayoutRedirectsToBootstrap("/renew");

    expect(readTelegramLaunchInitData()).toBe(INIT_DATA);
  });

  /** Older clients and some desktop launch URLs put them in the query. */
  it("captures a query-delivered launch", () => {
    window.history.replaceState(
      {},
      "",
      `/renew?tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppPlatform=tdesktop`,
    );

    entryChunkRuns();
    // StealthLayout's `next` is `${pathname}${search}`, so the whole original
    // query is replaced by a single percent-encoded `next` value — the launch
    // parameters are no more recoverable from it than from a dropped fragment.
    stealthLayoutRedirectsToBootstrap("/renew?tgWebAppData=…");
    expect(new URLSearchParams(window.location.search).has("tgWebAppData")).toBe(false);

    expect(
      readTelegramLaunchInitData(),
      "a query-delivered launch was lost — the capture reads only the fragment, so the clients that deliver via the query stay broken",
    ).toBe(INIT_DATA);
  });

  /** A genuinely new document: reload, or the return leg from a gateway. */
  it("recovers a mirror-only launch after the document is replaced", () => {
    window.sessionStorage.setItem(
      SDK_LAUNCH_PARAMS_KEY,
      JSON.stringify({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" }),
    );
    // A new document has no in-memory capture at all.
    __resetTelegramLaunchCaptureForTests();
    window.history.replaceState({}, "", "/renew");

    expect(readTelegramLaunchInitData()).toBe(INIT_DATA);
  });

  /**
   * Telegram Web (weba/webk) runs the Mini App in an `iframe`. In a partitioned
   * or storage-blocked third-party context `window.sessionStorage` THROWS on
   * access, so the mirror — the entire documented fallback — silently does not
   * exist. The launch must still survive the client-side hop.
   */
  it("survives the hop when sessionStorage is unreachable, as in an iframe", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    window.history.replaceState(
      {},
      "",
      `/renew#tgWebAppData=${encodeURIComponent(INIT_DATA)}`,
    );

    entryChunkRuns();
    stealthLayoutRedirectsToBootstrap("/renew");

    expect(
      readTelegramLaunchInitData(),
      "with storage blocked the launch had nowhere to live — a Telegram Web deep-link is spent the moment StealthLayout redirects",
    ).toBe(INIT_DATA);
    read.mockRestore();
    write.mockRestore();
  });
});
