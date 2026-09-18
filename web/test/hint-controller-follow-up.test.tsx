// @vitest-environment jsdom

/**
 * The two follow-up asks after entry.
 *
 * The welcome pop-up is written by a panel automation that runs AFTER the
 * sign-up request has answered, so the cabinet's one ask on entry could land
 * before the delivery existed — and the welcome then waited for the customer's
 * next visit. The controller now looks twice more, at four and at fifteen
 * seconds after the mount.
 *
 * Almost every case below is about keeping that bounded, and about keeping it
 * from undoing the guards the controller already had; those have their own
 * suite in `hint-controller-queue.test.tsx`.
 *
 * Fake timers throughout, because the delays ARE the behaviour: on a real clock
 * each case would either take fifteen seconds or be unable to tell four from
 * fifteen.
 */

import { StrictMode, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HintDevice } from "@/lib/api-client/hints";
import { SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT } from "@/lib/subscription-provisioning-receipt";

const navigateSpy = vi.hoisted(() => vi.fn());

/** The language `useTranslation` reports, switchable mid-case. */
const i18nState = vi.hoisted(() => ({ language: "ru" }));

/** Sonner, captured rather than rendered — the queue suite explains why. */
const sonner = vi.hoisted(() => {
  const calls: Array<{ message: string; options: Record<string, unknown> }> = [];
  let nextId = 0;
  const capture = (message: string, options: Record<string, unknown> = {}) => {
    calls.push({ message, options });
    nextId += 1;
    return `toast-${nextId}`;
  };
  return {
    calls,
    info: capture,
    success: capture,
    warning: capture,
    error: capture,
    dismiss: () => undefined,
  };
});

const api = vi.hoisted(() => ({
  getNextHint: vi.fn(),
  markHintShown: vi.fn(async () => true),
  closeHint: vi.fn(async () => true),
  reportHintMoment: vi.fn(async () => false),
}));

vi.mock("@/lib/api-client/hints", () => api);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: i18nState.language },
  }),
}));
vi.mock("react-router", () => ({ useNavigate: () => navigateSpy }));
vi.mock("sonner", () => ({ toast: sonner }));

import { HintController } from "@/features/hints/hint-controller";

const AUDIENCE: HintDevice = { surface: "browser", formFactor: "desktop" };

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

/** A call that answers only when the case says so. */
function deferred<T = unknown>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A read that never answers.
 *
 * The default for cases where a broken bound could otherwise ask again and
 * again through settled promises alone. That loop would never yield to a timer,
 * so it would hang the run instead of failing it; stalled on this instead, it
 * stops after one extra ask and shows up in the count.
 */
const NEVER = new Promise(() => undefined);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  // RESET, not clear — the queue suite records the leftover-`Once` failure
  // that taught this.
  vi.resetAllMocks();
  api.markHintShown.mockResolvedValue(true);
  api.closeHint.mockResolvedValue(true);
  api.reportHintMoment.mockResolvedValue(false);
  i18nState.language = "ru";
  sonner.calls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Lets settled reads run through: an ask awaits its read, then draws. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  });
}

/** Moves the clock, then lets whatever the timers started run through. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function render(element: ReactElement = <HintController audience={AUDIENCE} />) {
  await act(async () => {
    root.render(element);
  });
  await settle();
}

async function completePurchase(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT));
  });
  await settle();
}

const asks = () => api.getNextHint.mock.calls.length;
const dialogText = () => document.querySelector("[role='dialog']")?.textContent ?? null;
const buttonLabelled = (label: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === label);

const AN_HOUR = 60 * 60_000;

describe("a hint the panel queues just after entry", () => {
  it("is drawn by the follow-up at four seconds, with no remount", async () => {
    api.getNextHint
      .mockResolvedValueOnce(null) // on entry: the automation has not written it yet
      .mockResolvedValueOnce(hint({ deliveryId: "d-welcome", mode: "TOAST" }));

    await render();
    expect(asks()).toBe(1);

    await advance(3_999);
    expect(asks(), "asked again before four seconds had passed").toBe(1);

    await advance(1);
    expect(asks()).toBe(2);
    expect(sonner.calls).toHaveLength(1);
    expect(api.markHintShown).toHaveBeenCalledWith("d-welcome");
  });

  it("is drawn by the follow-up at fifteen seconds when the first found nothing either", async () => {
    api.getNextHint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(hint({ deliveryId: "d-welcome", title: "Добро пожаловать" }));

    await render();
    await advance(4_000);
    expect(asks()).toBe(2);
    expect(dialogText()).toBeNull();

    await advance(10_999);
    expect(asks(), "asked again before fifteen seconds had passed").toBe(2);

    await advance(1);
    expect(asks()).toBe(3);
    expect(api.markHintShown).toHaveBeenCalledWith("d-welcome");
    expect(dialogText()).toContain("Добро пожаловать");
  });

  it("asks in the language the customer has at that moment, not the one at mount", async () => {
    // Switching language in the first seconds is ordinary — it is one of the
    // first things a new customer does. A follow-up holding the mount's `ask`
    // would fetch the welcome in the language they just left.
    api.getNextHint.mockResolvedValue(null);

    await render();
    i18nState.language = "en";
    await render();
    await advance(4_000);

    expect(api.getNextHint.mock.calls[1]?.[0]).toEqual({ ...AUDIENCE, locale: "en" });
  });
});

describe("the follow-ups stay bounded", () => {
  it("asks twice more and never again, however long the page stays open", async () => {
    api.getNextHint.mockResolvedValue(null);

    await render();
    await advance(AN_HOUR);

    expect(asks()).toBe(3);
  });

  it("arms once per mount, not again on a re-render", async () => {
    // `audience` can get a new identity when the session is refetched, and `ask`
    // gets one on every navigation. Re-arming on either was the easy mistake:
    // two more asks after every page the customer opens is a poll.
    api.getNextHint.mockResolvedValue(null);

    await render();
    await advance(5_000); // the first follow-up has fired
    expect(asks()).toBe(2);

    await render(<HintController audience={{ ...AUDIENCE }} />);
    await advance(12_000);
    await render(<HintController audience={{ ...AUDIENCE }} />);
    await advance(AN_HOUR);

    expect(asks()).toBe(3);
  });

  it("arms exactly one pair under StrictMode, which is how the cabinet mounts", async () => {
    // StrictMode mounts, unmounts and mounts again. The rehearsal's pair must
    // be cleared, and the real mount's pair must still fire.
    api.getNextHint.mockResolvedValue(null);

    await render(
      <StrictMode>
        <HintController audience={AUDIENCE} />
      </StrictMode>,
    );
    await advance(AN_HOUR);

    expect(asks()).toBe(3);
  });
});

describe("once a hint has been drawn this visit", () => {
  it("does not ask after a toast that simply ran out of seconds", async () => {
    // The expiry branch refuses to ask again: a toast every eight seconds is a
    // nag. A follow-up that ignored it would be the same nag on a timer.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockResolvedValue(hint({ deliveryId: "d-other", mode: "TOAST" }));

    await render();
    expect(sonner.calls).toHaveLength(1);
    await advance(1_000);
    await act(async () => {
      (sonner.calls[0]?.options["onAutoClose"] as () => void)();
    });
    await advance(AN_HOUR);

    expect(asks()).toBe(1);
    expect(sonner.calls).toHaveLength(1);
  });

  it("does not ask after the customer acted on a modal", async () => {
    // Acting navigates, and a hint opening on the page somebody was just sent
    // to is exactly what the controller refuses after `acted`.
    api.getNextHint
      .mockResolvedValueOnce(
        hint({ deliveryId: "d1", ctaKind: "ROUTE", ctaLabel: "Открыть", ctaTarget: "/renew" }),
      )
      .mockResolvedValue(hint({ deliveryId: "d-other" }));

    await render();
    const cta = buttonLabelled("Открыть");
    expect(cta, "the hint modal is not on screen").toBeDefined();
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(navigateSpy).toHaveBeenCalledWith("/renew");

    await advance(AN_HOUR);

    expect(asks()).toBe(1);
    expect(api.markHintShown).not.toHaveBeenCalledWith("d-other");
  });
});

describe("when the shell goes away", () => {
  it("never asks for a session that is gone", async () => {
    // A sign-out unmounts the shell. A follow-up still armed after that would
    // ask on behalf of nobody, from the sign-in screen.
    api.getNextHint.mockResolvedValue(null);

    await render();
    await advance(1_000);
    await act(async () => root.unmount());
    await advance(AN_HOUR);

    expect(asks()).toBe(1);
  });
});

describe("a follow-up that meets another ask", () => {
  it("does not read alongside the retry that follows closing an undrawable hint", async () => {
    // A modal or a toast is only ever closed after it was drawn, and a draw
    // disarms the follow-ups — so the one close-triggered ask a follow-up can
    // actually meet is the retry after closing a mode this build cannot draw.
    // One read at a time still holds, and the retry's answer is drawn once.
    const closed = deferred<boolean>();
    const retryRead = deferred();
    api.getNextHint.mockReturnValue(NEVER);
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-unknown", mode: "SPOTLIGHT" }))
      .mockReturnValueOnce(retryRead.promise);
    api.closeHint.mockReturnValueOnce(closed.promise);

    await render();
    expect(api.closeHint).toHaveBeenCalledWith("d-unknown", "dismissed");

    await advance(3_900);
    await act(async () => {
      closed.resolve(true);
    });
    await settle();
    expect(asks(), "the retry did not start").toBe(2);

    await advance(100); // four seconds: the follow-up fires while the retry reads
    expect(asks(), "the follow-up read alongside the retry").toBe(2);

    await act(async () => {
      retryRead.resolve(hint({ deliveryId: "d2", mode: "TOAST" }));
    });
    await settle();
    await advance(AN_HOUR);

    expect(asks()).toBe(2);
    expect(sonner.calls).toHaveLength(1);
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
    expect(api.markHintShown).toHaveBeenCalledWith("d2");
  });
});

describe("the purchase path, which the follow-ups sit right on top of", () => {
  it("draws a purchase that completes before the follow-ups, which then stay quiet", async () => {
    api.getNextHint
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase", key: "subscription-ready" }))
      .mockResolvedValue(hint({ deliveryId: "d-other" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await advance(2_000);
    await completePurchase();
    expect(api.markHintShown).toHaveBeenCalledWith("d-purchase");

    await advance(AN_HOUR);

    expect(asks()).toBe(2);
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });

  it("does not let a follow-up's read swallow a purchase that completes during it", async () => {
    // THE COLLISION THE FOLLOW-UPS BROUGHT WITH THEM. An ask raised while
    // another read is in flight is normally satisfied by that read. A
    // follow-up's read left on a clock — here before the purchase was written —
    // and the follow-ups sit in the first seconds of a visit, which is exactly
    // when a customer back from the payment page finishes provisioning. Counted
    // as answered, the purchase hint waited for the next visit.
    const followUpRead = deferred();
    api.getNextHint.mockReturnValue(NEVER);
    api.getNextHint
      .mockResolvedValueOnce(null) // on entry
      .mockReturnValueOnce(followUpRead.promise) // the follow-up, left before the purchase
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase", title: "Подписка готова" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await advance(4_000);
    expect(asks()).toBe(2);

    await completePurchase();
    expect(asks(), "the purchase read alongside the follow-up").toBe(2);

    await act(async () => {
      followUpRead.resolve(null);
    });
    await settle();

    expect(asks()).toBe(3);
    expect(api.markHintShown).toHaveBeenCalledWith("d-purchase");
    expect(dialogText()).toContain("Подписка готова");
  });

  it("draws what the read issued after the purchase returns, not what the follow-up fetched", async () => {
    // The follow-up's answer predates the purchase. If that row has left the
    // queue in between — shown in another tab, say — drawing it from the stale
    // answer would show it twice; the fresher read is the one that knows.
    const followUpRead = deferred();
    api.getNextHint.mockReturnValue(NEVER);
    api.getNextHint
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(followUpRead.promise)
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase", title: "Подписка готова" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await advance(4_000);
    await completePurchase();
    await act(async () => {
      followUpRead.resolve(hint({ deliveryId: "d-stale", title: "Уже показана" }));
    });
    await settle();

    expect(api.markHintShown).not.toHaveBeenCalledWith("d-stale");
    expect(api.markHintShown).toHaveBeenCalledWith("d-purchase");
    expect(dialogText()).toContain("Подписка готова");
  });

  it("does not ask for that purchase once the shell has gone away", async () => {
    const followUpRead = deferred();
    api.getNextHint.mockReturnValue(NEVER);
    api.getNextHint
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(followUpRead.promise)
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await advance(4_000);
    await completePurchase();
    await act(async () => root.unmount());
    await act(async () => {
      followUpRead.resolve(null);
    });
    await settle();

    expect(asks()).toBe(2);
    expect(api.markHintShown).not.toHaveBeenCalled();
  });
});
