// @vitest-environment jsdom

/**
 * The `?link=email` deep link, exercised through the real pair that produces
 * it in the app: `BrandingProvider` -> `PrivacyPage`.
 *
 * `privacy-deep-link.test.tsx` covers the decision in isolation and stayed
 * green while the feature was broken, because it fed the function a
 * `brandingLoading: true` the application could never produce: the branding
 * query always ships `placeholderData`, so React Query reported `success` on
 * the first render and `isLoading` was false for the whole life of the app.
 * The cold-load branch was therefore unreachable, `emailEnabled` was read off
 * the built-in defaults (`false`), and a valid link was consumed and stripped
 * before the operator config ever arrived.
 */

import {
  QueryClient,
  QueryClientProvider,
  defaultScheduler,
  notifyManager,
} from "@tanstack/react-query";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PUBLIC_CONFIG, type PublicConfig } from "../src/types/branding";

const api = vi.hoisted(() => ({
  getReiwaPublicConfig: vi.fn(),
  getSession: vi.fn(),
  changePasswordAuth: vi.fn(),
  initiateEmailLink: vi.fn(),
  initiateTelegramLink: vi.fn(),
  verifyEmailLink: vi.fn(),
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "ru", changeLanguage: vi.fn() },
  }),
}));
vi.mock("@/lib/branding-document", () => ({
  applyBrandingToDocument: vi.fn(),
  clearBootstrapAppBackground: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
}));

import { BrandingProvider } from "../src/lib/branding-provider";
import PrivacyPage from "../src/features/settings/privacy-page";

const EMAIL_ENABLED_CONFIG: PublicConfig = { ...DEFAULT_PUBLIC_CONFIG, emailEnabled: true };

/** Marker rendered only inside the open Email linking form. */
const EMAIL_FORM = "privacy.linkEmailHint";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let search = "";

function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    search = location.search;
  }, [location.search]);
  return null;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mount(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/settings/privacy?link=email"]}>
          <LocationProbe />
          <BrandingProvider>
            <PrivacyPage />
          </BrandingProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Flushes React work queued by the notifications that already landed. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React Query hands every observer notification to `notifyManager`, which by
  // default defers it onto a real `setTimeout(…, 0)`. That timer is registered
  // while the resolved query promise drains its microtasks — i.e. strictly
  // *after* the timer any `await act(…)` here has already registered for its
  // own wakeup. Both are 0 ms, so they share a timer phase only while the drain
  // stays inside one millisecond; cross that boundary (which the full-suite run
  // does under load) and the act scope wakes, finds an empty work queue and
  // resolves before the config ever reached the tree. Running notifications on
  // the microtask queue removes the wall clock from the ordering: microtasks
  // always drain ahead of timers, so the re-render is queued inside the open
  // act scope before any wait can end. Notifications stay asynchronous, as in
  // production — only the queue they ride on changes.
  notifyManager.setScheduler(queueMicrotask);
  search = "";
  window.localStorage.clear();
  api.getSession.mockResolvedValue(null);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PrivacyPage cold-load deep link", () => {
  it("holds ?link=email until branding confirms the channel, then opens the form", async () => {
    const config = deferred<PublicConfig>();
    api.getReiwaPublicConfig.mockReturnValue(config.promise);

    mount();
    await settle();

    // Still in flight: the built-in defaults say `emailEnabled: false`, which
    // is not an operator answer. Consuming here is what swallowed the link.
    expect(search).toContain("link=email");
    expect(container?.textContent ?? "").not.toContain(EMAIL_FORM);

    act(() => config.resolve(EMAIL_ENABLED_CONFIG));
    await settle();

    expect(container?.textContent ?? "").toContain(EMAIL_FORM);
    expect(search).toBe("");
  });

  it("consumes the link instead of waiting forever when branding never loads", async () => {
    vi.useFakeTimers();
    try {
      api.getReiwaPublicConfig.mockRejectedValue(new Error("public-config unreachable"));

      mount();
      // Anchor the probe before the wait: without this the closing assertion
      // would also hold for a page that never rendered at all, since `search`
      // starts empty.
      expect(search).toBe("?link=email");

      // `retry: 2` with the default backoff settles the query as `error` inside
      // ~3s. The placeholder branch only applies while the query is `pending`,
      // so the wait releases itself rather than pinning the page on defaults.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(search).toBe("");
      expect(container?.textContent ?? "").not.toContain(EMAIL_FORM);
    } finally {
      vi.useRealTimers();
    }
  });
});
