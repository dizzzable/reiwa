// @vitest-environment jsdom

/**
 * The cabinet hint and the REAL onboarding tour, together.
 *
 * Reported 21.09.2026 with a screen recording: a customer finished paying, the
 * modal «Готово! Подписка оформлена» opened with its «Подключиться», and four
 * seconds later the tutorial started ON TOP of it — the spotlight dimmed the
 * whole page including the modal it could not see, leaving a greyed-out,
 * still-clickable dialog under a tooltip about a card it was covering.
 *
 * They are raised by the same moment, a finished purchase, and neither knew
 * about the other. The rule is that the tutorial goes first, and it takes both
 * directions to hold:
 *
 *   * the hint does not draw while the tour is on screen or due
 *     (`mustWaitForTour`, the push prompt's own rule, reused);
 *   * the tour does not start while a hint is already up (`hint-presence.ts`),
 *     for the race the hint wins — a hint drawn a second before the tour
 *     became due is already on screen, and nothing about the tour's own state
 *     says so.
 *
 * Both are contracts with files their owners do not own, and both would break
 * silently: the two would simply overlap again. So this renders the real
 * provider and the real controller and drives them the way a purchase does.
 */

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAllSubscriptions: vi.fn(),
  setOnboardingCompleted: vi.fn(),
}));
vi.mock("@/lib/api-client", () => api);

const hintsApi = vi.hoisted(() => ({
  getNextHint: vi.fn(),
  markHintShown: vi.fn(async () => true),
  closeHint: vi.fn(async () => true),
  reportHintMoment: vi.fn(async () => false),
}));
vi.mock("@/lib/api-client/hints", () => hintsApi);

const navigateSpy = vi.hoisted(() => vi.fn());
/** The route the shell is on, movable so a case can walk onto the dashboard. */
const route = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: route.pathname, search: "", hash: "", state: null, key: "k" }),
  useNavigate: () => navigateSpy,
}));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  // A customer who has never seen the tour: it is due on this dashboard.
  useSession: () => ({
    session: { id: "u-1", telegramId: null, name: "U", role: "USER", onboardingCompleted: false },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
// Exit animations finish at once, so "skipped" means "gone".
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  const strip = (props: Record<string, unknown>): Record<string, unknown> => {
    const { initial, animate, exit, transition, whileTap, whileHover, layout, ...rest } = props;
    return rest;
  };
  return {
    motion: new Proxy(
      {},
      { get: (_target, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) },
    ),
    AnimatePresence: ({ children }: { children?: unknown }) => children,
  };
});

import { i18n } from "@/i18n/i18n";
import { HintController } from "@/features/hints/hint-controller";
import { isHintOnScreen, setHintOnScreen } from "@/features/hints/hint-presence";
import { OnboardingTourProvider } from "@/features/onboarding/onboarding-tour-controller";

const AUDIENCE = { surface: "browser", formFactor: "desktop", os: "linux" } as never;

const CONNECT_HINT = {
  deliveryId: "d1",
  key: "subscription-ready",
  mode: "MODAL",
  tone: "INFO",
  title: "Готово! Подписка оформлена.",
  body: "Теперь самое важное — подключить ваш смартфон или ПК.",
  ctaKind: "NONE",
  ctaLabel: null,
  ctaTarget: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function buttonSaying(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

/** The real tour's own «Пропустить», present exactly while its tooltip is. */
function skipButton(): HTMLButtonElement | undefined {
  return buttonSaying(i18n.t("onboarding.skip"));
}

/** The hint modal's «Позже» — the one button that dialog always has. */
function laterButton(): HTMLButtonElement | undefined {
  return buttonSaying(i18n.t("hints.later"));
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <OnboardingTourProvider>
          <div data-tour="subscription-card" />
          <HintController audience={AUDIENCE} />
        </OnboardingTourProvider>
      </QueryClientProvider>,
    );
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  window.sessionStorage.clear();
  window.localStorage.clear();
  // A module flag outlives a test. Left set by a case that ends with a hint on
  // screen, it would hold the tour back in the NEXT one — which is exactly the
  // bug the unmount release exists to prevent, and not something to discover
  // as a mystery failure two cases later.
  setHintOnScreen(false);
  route.pathname = "/dashboard";
  // CLEARED, not just re-implemented. `mockResolvedValue` leaves the call
  // history in place, so `markHintShown` still carried the stamps of every
  // earlier case — and a `not.toHaveBeenCalled()` below failed on two calls
  // that belonged to two other tests.
  vi.clearAllMocks();
  hintsApi.getNextHint.mockReset();
  hintsApi.markHintShown.mockResolvedValue(true);
  hintsApi.closeHint.mockResolvedValue(true);
  hintsApi.reportHintMoment.mockResolvedValue(false);
  api.setOnboardingCompleted.mockResolvedValue({ success: true });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the connect helper and the tutorial never share the screen", () => {
  it("holds the hint back while the tour runs, and draws it once the tour is skipped", async () => {
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
    hintsApi.getNextHint.mockResolvedValue(CONNECT_HINT);

    await mount();

    // Before the tour starts it is already DUE, and that is enough to wait on:
    // this is the window the recording caught, where the modal drew first.
    await advance(300);
    expect(skipButton(), "the tour started early").toBeUndefined();
    expect(laterButton(), "the hint drew in the moment before the tour").toBeUndefined();

    // The provider starts the tour 600 ms after it has an active subscription.
    await advance(700);
    expect(skipButton(), "the real tour did not start").toBeDefined();
    expect(laterButton(), "the hint drew under the tour").toBeUndefined();

    // A long read of the tutorial: still nothing — and NOTHING STAMPED SHOWN,
    // which is the part that matters. A hint marked shown while it was never
    // drawn leaves the queue for good.
    await advance(30_000);
    expect(laterButton()).toBeUndefined();
    expect(hintsApi.markHintShown).not.toHaveBeenCalled();

    await act(async () => {
      skipButton()!.click();
    });
    await advance(1_000);

    expect(skipButton(), "the tour is still on screen").toBeUndefined();
    expect(laterButton(), "the hint never came back after the tour").toBeDefined();
    expect(hintsApi.markHintShown).toHaveBeenCalledWith("d1");
    // …and the tour is told, so the other direction cannot fire underneath it.
    expect(isHintOnScreen()).toBe(true);
  });

  it("makes the tour wait when the hint got there first, and lets it through on close", async () => {
    // The race the first case cannot cover: the hint was drawn somewhere the
    // tour does not run, and the customer then walked onto the dashboard. The
    // modal is already on screen and nothing about the tour's own state says
    // so — which is why waiting for the tour cannot be the only rule.
    route.pathname = "/settings";
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
    hintsApi.getNextHint.mockResolvedValue(CONNECT_HINT);

    await mount();
    await advance(100);

    expect(laterButton(), "the hint did not draw away from the dashboard").toBeDefined();
    expect(isHintOnScreen()).toBe(true);

    // Onto the dashboard, where the tour is due — and must not open over the
    // modal. The receipt notification is what the shell re-renders on here; a
    // real navigation re-renders the provider the same way.
    route.pathname = "/dashboard";
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("reiwa:subscription-provisioning-receipts-changed", {
          detail: { hasPendingProvisioning: false },
        }),
      );
    });
    await advance(5_000);
    expect(skipButton(), "the tour started on top of the hint").toBeUndefined();
    expect(laterButton(), "the hint was taken off the screen").toBeDefined();

    // The customer answers the hint. Now, and only now, the tutorial runs: it
    // is still due, because it is marked seen when it STARTS.
    hintsApi.getNextHint.mockResolvedValue(null);
    await act(async () => {
      laterButton()!.click();
    });
    await advance(1_000);

    expect(isHintOnScreen()).toBe(false);
    expect(laterButton(), "the hint is still on screen").toBeUndefined();
    expect(skipButton(), "the tour never ran").toBeDefined();
  });


  it("throws away an answer that came back after the tour had started", async () => {
    // The gate at the top of `ask` is read BEFORE the request leaves, and a
    // request is not instant. Any read issued while the tour was not in the
    // way can return into a tour that has since started — here by walking
    // onto the dashboard mid-read, but a dismissal does the same thing:
    // releasing the slot both asks again and lets the tour start 600 ms
    // later, so any read slower than that lands on top of it.
    route.pathname = "/settings";
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [{ id: "sub-1", status: "ACTIVE" }] });
    hintsApi.getNextHint.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(CONNECT_HINT), 3_000);
        }),
    );

    await mount();
    await advance(100);

    // NON-VACUITY: away from the dashboard nothing holds the hint, so the
    // read really left. Without this the case would pass just as well if the
    // FIRST gate had stopped everything, and it would guard nothing — which
    // is exactly what an earlier version of it did.
    expect(hintsApi.getNextHint, "no read was ever issued").toHaveBeenCalled();
    expect(laterButton(), "the slow read drew instantly").toBeUndefined();

    // Onto the dashboard while that read is still in flight. The tour starts
    // 600 ms later; the answer is due at 3 s.
    route.pathname = "/dashboard";
    // TWO events, with a tick between them. The provider re-reads the route
    // only when something makes it render, and a receipt notification that
    // repeats the value it already holds makes React bail out — so one
    // dispatch of `false` over a `false` changes nothing at all.
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("reiwa:subscription-provisioning-receipts-changed", {
          detail: { hasPendingProvisioning: true },
        }),
      );
    });
    await advance(10);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("reiwa:subscription-provisioning-receipts-changed", {
          detail: { hasPendingProvisioning: false },
        }),
      );
    });
    await advance(5_000);

    expect(skipButton(), "the tour never started").toBeDefined();
    expect(laterButton(), "a late answer was drawn on top of the tour").toBeUndefined();
    // …and NOT stamped: a hint marked shown but never drawn leaves the queue
    // for good, which is worse than showing it late.
    expect(hintsApi.markHintShown).not.toHaveBeenCalled();

    // It is not lost either — the tour letting go brings it back.
    hintsApi.getNextHint.mockResolvedValue(CONNECT_HINT);
    await act(async () => {
      skipButton()!.click();
    });
    await advance(1_000);
    expect(laterButton(), "the deferred hint never came back").toBeDefined();
  });

  it("draws the hint at once when the tour is not due at all", async () => {
    // ANTI-VACUITY. Both cases above assert an absence, and an absence is what
    // a controller that never draws anything produces too. A returning
    // customer — no tour due, because they have seen it — must get the hint
    // immediately.
    api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
    hintsApi.getNextHint.mockResolvedValue(CONNECT_HINT);

    await mount();
    await advance(100);

    expect(laterButton(), "the hint never drew with no tour in the way").toBeDefined();
    expect(skipButton()).toBeUndefined();
  });
});
