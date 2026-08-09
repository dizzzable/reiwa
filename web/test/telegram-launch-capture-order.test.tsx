// @vitest-environment jsdom

/**
 * The launch payload must be captured BEFORE React renders anything.
 *
 * Telegram writes `tgWebAppData` into the launch document's `location.hash`,
 * and the first react-router navigation drops it. On a deep-link launch —
 * `${miniAppUrl}/renew`, the expiry notification's «Продлить» button — that
 * navigation happens immediately, so whatever has not read the payload by then
 * never will: `/bootstrap` finds nothing, falls back to waiting for
 * telegram.org (the one host a VPN-less customer cannot reach) and the
 * subscriber lands on a password form.
 *
 * The capture used to sit in `useTelegramWebApp`'s effect at the application
 * root, on the theory that the root is the earliest point that sees every
 * launch. **That is false for React.** `<Navigate>` is itself a `useEffect`
 * (react-router 8, `dist/development/lib/components.js`), and React runs CHILD
 * effects before parent ones — so a gate that returns `<Navigate>` on its first
 * render fires `history.replaceState` before the root's effect ever runs.
 *
 * It survived only by accident: today's session gate is asynchronous, because
 * `use-session.ts` has no `initialData`, no `placeholderData` and no persister,
 * so `isLoading` is true on the first render and `StealthLayout` paints a
 * spinner. `App.tsx`'s `/ref/:token` route (`ReferralLinkRedirect`) already
 * loses it — it returns `<Navigate>` on its first render — and giving
 * `useSession` an `initialData` would silently break every deep-link launch
 * with no test to say so.
 *
 * So this file executes the race, against the real thing on every side:
 *   - the real `web/src/main.tsx`, imported as a module, which is where the
 *     capture now lives (module scope, before `createRoot(root).render(…)`);
 *   - the real `createRoot` from `react-dom/client`, so effect ordering is
 *     React's own;
 *   - the real `BrowserRouter` and the real `<Navigate>`, so the fragment is
 *     dropped by the same code that drops it in production.
 *
 * The app root is the ONLY substitution: the smallest tree with the shape that
 * loses the race — a component that calls the root hook and renders a
 * `<Navigate>` as its child. `window.Telegram` is defined nowhere, so anything
 * that passes was decided from the URL alone.
 *
 * Move the capture back into a React effect and every case here goes red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/** Roots created by `main.tsx`, so each case can be torn down. */
const roots = vi.hoisted(() => [] as { unmount: () => void }[]);

// `createRoot` stays REAL — the effect ordering under test is React's. This
// only keeps a handle on the root `main.tsx` creates, which it does not export.
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (container: Element | DocumentFragment, options?: unknown) => {
      const root = actual.createRoot(container, options as never);
      roots.push(root);
      return root;
    },
  };
});

// The entry chunk's neighbours. `main.tsx` is executed for real, so everything
// it touches on the way to `render(…)` has to resolve — none of it is what this
// file is about, and none of it may navigate.
vi.mock("@/lib/register-sw", () => ({ registerServiceWorker: vi.fn() }));
vi.mock("@/lib/client-error-reporter", () => ({
  installGlobalErrorReporting: vi.fn(),
  reportClientError: vi.fn(),
}));
vi.mock("@/lib/ios-zoom-lock", () => ({ installIosZoomLock: vi.fn() }));
vi.mock("@/lib/query-client", () => ({ queryClient: {} }));
vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/error-boundary", () => ({
  AppErrorBoundary: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/lib/branding-provider", () => ({
  BrandingProvider: ({ children }: { readonly children?: ReactNode }) => children,
}));
vi.mock("@/i18n/i18n", () => ({}));

/**
 * The app root, reduced to the shape that loses the race.
 *
 * `useTelegramWebApp()` is what `App.tsx:104` calls on every route — the place
 * the capture used to live. The `<Navigate>` beneath it is a real react-router
 * `<Navigate>`, rendered on the FIRST render, which is `ReferralLinkRedirect`
 * (`App.tsx:41`) today and any synchronous session gate tomorrow.
 *
 * `createElement` rather than JSX on purpose: each case runs against a fresh
 * module registry, and this keeps every React object in the tree coming from
 * that generation's own copy of React.
 */
vi.mock("@/App", async () => {
  const { createElement } = await import("react");
  const { Navigate } = await import("react-router");
  const { useTelegramWebApp } = await import("@/hooks/use-telegram-webapp");
  return {
    default: function RedirectingRoot() {
      useTelegramWebApp();
      return createElement(Navigate, { to: "/bootstrap", replace: true });
    },
  };
});

/**
 * A signed Telegram launch payload with `auth_date` stamped NOW — the module
 * refuses to replay a carried payload past the server's own 24h window, so a
 * fixture from 1970 would be dropped for a reason this file is not about.
 */
const INIT_DATA = `user=%7B%22id%22%3A42%7D&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;
const SDK_LAUNCH_PARAMS_KEY = "__telegram__initParams";

const hosts: HTMLElement[] = [];

/**
 * Opens the document Telegram opened and runs the real entry chunk on it.
 *
 * `vi.resetModules()` gives each case its own module registry, which is what a
 * document is: `main.tsx` executes its body exactly once per import. Everything
 * the case needs afterwards is imported from that same generation, so the
 * in-memory capture being asserted on is the one `main.tsx` actually wrote.
 */
async function launchDocument(
  url: string,
): Promise<typeof import("@/lib/telegram-launch-params")> {
  window.history.replaceState({}, "", url);
  vi.resetModules();
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  hosts.push(host);
  const { act } = await import("react");
  await act(async () => {
    await import("@/main");
  });
  return await import("@/lib/telegram-launch-params");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
  // The whole point: the bridge never arrives. telegram.org is unreachable.
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "Telegram");
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "__reiwaTelegramSdkState");
});

afterEach(async () => {
  const { act } = await import("react");
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  const { __resetTelegramWebAppBridgeForTests } = await import("@/hooks/use-telegram-webapp");
  __resetTelegramWebAppBridgeForTests();
  for (const host of hosts.splice(0)) host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the launch capture runs before React's first render", () => {
  it.each([
    [
      "a deep-link launch onto a protected route",
      "/renew",
      "the bot's expiry notification opens `${miniAppUrl}/renew`; StealthLayout is the gate in front of it",
    ],
    [
      "a launch onto /ref/:token, which redirects on its first render today",
      "/ref/abc123",
      "`ReferralLinkRedirect` (App.tsx:41) returns <Navigate> immediately, and `webAppPath` is operator-supplied so /ref/<token> is a configurable deep-link target",
    ],
  ])("survives %s", async (_name, path, why) => {
    const launchParams = await launchDocument(
      `${path}#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6&tgWebAppPlatform=ios`,
    );

    // The race actually ran: a real `<Navigate>` replaced the URL, taking the
    // fragment with it. Without this the case could pass on a tree that never
    // navigated at all.
    expect(
      window.location.hash,
      "no navigation happened, so nothing raced the capture and this case proves nothing",
    ).toBe("");
    expect(window.location.pathname).toBe("/bootstrap");

    expect(launchParams.readTelegramLaunchInitData(), why).toBe(INIT_DATA);
    expect(window.Telegram, "the bridge was defined; this case proves nothing").toBeUndefined();
  });

  it("mirrors the payload for the next document in the tab, before the same navigation", async () => {
    // A reload — which is what the bootstrap error screen's Retry does — and the
    // return leg from a payment gateway are NEW documents: memory is gone and
    // the mirror is the only carrier left.
    await launchDocument(
      `/renew#tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppVersion=9.6`,
    );

    expect(
      JSON.parse(window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY) ?? "null"),
      "the launch was never mirrored before the redirect — a reload in this tab has no payload left",
    ).toMatchObject({ tgWebAppData: INIT_DATA, tgWebAppVersion: "9.6" });
  });

  it("survives the race with sessionStorage unreachable, as in a Telegram Web iframe", async () => {
    // weba/webk run the Mini App in an iframe, and a partitioned or
    // storage-blocked third-party context THROWS on `sessionStorage` access. The
    // documented fallback then does not exist, so the in-memory capture is the
    // only thing between the launch and the password form — and it only helps
    // if it happened before the navigation.
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      const launchParams = await launchDocument(
        `/renew#tgWebAppData=${encodeURIComponent(INIT_DATA)}`,
      );

      expect(window.location.hash).toBe("");
      expect(
        launchParams.readTelegramLaunchInitData(),
        "with storage blocked the launch had nowhere to live — a Telegram Web deep-link is spent the moment the first gate redirects",
      ).toBe(INIT_DATA);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it("captures a query-delivered launch through the same race", async () => {
    // Older clients and some desktop launch URLs put the parameters in the
    // query, and a react-router navigation drops that too.
    const launchParams = await launchDocument(
      `/renew?tgWebAppData=${encodeURIComponent(INIT_DATA)}&tgWebAppPlatform=tdesktop`,
    );

    expect(window.location.search).toBe("");
    expect(
      launchParams.readTelegramLaunchInitData(),
      "a query-delivered launch was lost — the clients that deliver that way stay broken",
    ).toBe(INIT_DATA);
  });

  it("writes nothing for a document with no launch parameters", async () => {
    // The other end: a fix that captured unconditionally would make every plain
    // browser visit look like a Mini App, and would leave the SDK's own key
    // sitting in a session Telegram never launched.
    const launchParams = await launchDocument("/renew");

    expect(launchParams.readTelegramLaunchInitData()).toBeNull();
    expect(window.sessionStorage.getItem(SDK_LAUNCH_PARAMS_KEY)).toBeNull();
  });
});
