// @vitest-environment jsdom

/**
 * The queue must survive the hints it does not draw.
 *
 * Two ways this controller silently destroyed a customer's queue, both found in
 * final review and both invisible from the outside — the modal that DID appear
 * looked perfectly correct in each case.
 *
 * 1. A hint arriving while a modal was open was thrown away by the state
 *    updater and then stamped SHOWN anyway. `nextFor` filters on `shownAt:
 *    null`, so that delivery became permanently invisible: never drawn, never
 *    re-offered, and — because the flagship hint is non-repeatable — never
 *    raised again either. The purchase hint died exactly this way, since buying
 *    is the one thing that queues a hint mid-visit.
 *
 * 2. A hint in a mode this build cannot draw was skipped without being closed,
 *    so it stayed at the head of an ascending-`createdAt` queue and blocked
 *    every later hint for up to ninety days.
 */

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateSpy = vi.hoisted(() => vi.fn());
/**
 * Sonner, captured rather than rendered.
 *
 * The toast's outcomes are callbacks sonner invokes — the action's `onClick`,
 * `onDismiss`, `onAutoClose` — and driving them through a real toast would mean
 * driving sonner's timers and DOM to assert something that is entirely about
 * which callback reports what. Captured, each of the three can be fired
 * directly, which is the only way to tell an auto-close from a dismissal.
 */
const sonner = vi.hoisted(() => {
  const calls: Array<{ message: string; options: Record<string, unknown> }> = [];
  /** Every id sonner was asked to take off the screen programmatically. */
  const dismissed: Array<string | number> = [];
  let nextId = 0;
  /** Set to make the NEXT raise throw, for the "cannot be drawn" case. */
  const state = { throwOnce: false };
  const capture = (message: string, options: Record<string, unknown> = {}) => {
    if (state.throwOnce) {
      state.throwOnce = false;
      throw new Error('no translator');
    }
    calls.push({ message, options });
    nextId += 1;
    return `toast-${nextId}`;
  };
  return {
    calls,
    dismissed,
    state,
    info: capture,
    success: capture,
    warning: capture,
    error: capture,
    // Real, because the controller now calls it on unmount and a mock without
    // it turned "the toast is cleaned up" into a TypeError inside a callback.
    dismiss: (id: string | number) => {
      dismissed.push(id);
    },
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
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "ru" } }),
}));
vi.mock("react-router", () => ({ useNavigate: () => navigateSpy }));
vi.mock("sonner", () => ({ toast: sonner }));

import { HintController } from "@/features/hints/hint-controller";

const AUDIENCE = { surface: "browser", formFactor: "desktop", os: "linux" } as never;

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // RESET, not clear. `clearAllMocks` wipes recorded calls but leaves both the
  // implementations and any UNCONSUMED `mockResolvedValueOnce` queued — so a
  // case that queues two answers and uses one hands the leftover to whichever
  // case runs next, and a real regression then reddens a test that has nothing
  // to do with it. That happened while these cases were being written: a
  // failure planted in the drain logic surfaced as `toast(...).onAutoClose is
  // not a function` two tests away.
  vi.resetAllMocks();
  // The two defaults every case relies on, re-established because the reset
  // above takes the implementations with it.
  api.markHintShown.mockResolvedValue(true);
  api.closeHint.mockResolvedValue(true);
  api.reportHintMoment.mockResolvedValue(false);
  sonner.calls.length = 0;
  sonner.dismissed.length = 0;
  sonner.state.throwOnce = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<HintController audience={AUDIENCE} />);
  });
}

describe("a hint the controller does not draw", () => {
  it("is not stamped shown when a modal is already open", async () => {
    // First ask wins the screen; the second arrives while it is still up.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d1" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d2", key: "subscription-ready" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    expect(api.markHintShown).toHaveBeenCalledWith("d1");

    // The purchase completes while the first modal is still on screen.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
    });

    // d2 was not drawn, so it MUST NOT be stamped. Stamping it here is what
    // made the flagship hint unreachable for ever.
    expect(api.markHintShown).not.toHaveBeenCalledWith("d2");
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });

  it("closes a mode it cannot render instead of leaving it at the head of the queue", async () => {
    // `SPOTLIGHT` stands for "a mode a newer panel introduced". It used to be
    // `TOAST` here, and that is no longer an undrawable mode — the cabinet
    // learned it. The case is about the mode it has NOT learned, whichever one
    // that is next.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-unknown", mode: "SPOTLIGHT" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" }));

    await render();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Closed, not skipped: skipping left it first in line for its whole TTL and
    // starved every hint behind it, a failed-payment one included.
    expect(api.closeHint).toHaveBeenCalledWith("d-unknown", "dismissed");
    // …and the queue moved on rather than stopping there.
    expect(api.getNextHint).toHaveBeenCalledTimes(2);
    expect(api.markHintShown).toHaveBeenCalledWith("d-modal");
  });

  it("stamps exactly once for the hint it does draw", async () => {
    // StrictMode double-invokes updaters and replays discarded renders, so a
    // side effect placed inside one fires more than once per hint.
    api.getNextHint.mockResolvedValue(hint({ deliveryId: "d1" }));
    await render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });
});

describe("a hint the operator asked to be a toast", () => {
  /**
   * WHY THE CABINET NEEDED A SECOND MODE.
   *
   * It could draw exactly one — a modal — so everything an operator wanted to
   * say arrived as a full-screen dialog over whatever the customer was doing.
   * Two of the eight ready-made pop-ups were written as toasts and had to be
   * rewritten as modals because of it. A library of thirty in one mode is
   * thirty ways to interrupt somebody.
   */
  const toast = () => sonner.calls[0]?.options ?? {};

  it("is raised as a toast and stamped shown, without a modal", async () => {
    api.getNextHint.mockResolvedValueOnce(
      hint({ deliveryId: "d-toast", mode: "TOAST", tone: "SUCCESS" }),
    );

    await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(sonner.calls).toHaveLength(1);
    expect(sonner.calls[0]?.message).toBe("T");
    expect(toast()["description"]).toBe("B");
    expect(api.markHintShown).toHaveBeenCalledWith("d-toast");
    // It is not the modal. The dialog would have taken the screen, which is the
    // whole thing this mode exists to avoid.
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("reports NOTHING when it simply runs out of seconds", async () => {
    // THE CASE THIS MODE TURNS ON. A dismissal is a decision — the panel treats
    // it as one and never shows that delivery again. A toast that expired while
    // the customer was reading the page carries no decision at all, so counting
    // it as a refusal would be inventing an answer on their behalf.
    api.getNextHint.mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }));

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      (toast()["onAutoClose"] as () => void)();
    });

    expect(api.closeHint).not.toHaveBeenCalled();
    // And it does not immediately fetch another: a toast every eight seconds is
    // the nagging this controller exists to prevent.
    expect(api.getNextHint).toHaveBeenCalledTimes(1);
  });

  it("reports a deliberate close as a dismissal, and moves the queue on", async () => {
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockResolvedValueOnce(null);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      (toast()["onDismiss"] as () => void)();
      await Promise.resolve();
    });

    expect(api.closeHint).toHaveBeenCalledWith("d-toast", "dismissed");
    expect(api.getNextHint).toHaveBeenCalledTimes(2);
  });

  it("follows the call to action and reports it once", async () => {
    api.getNextHint.mockResolvedValueOnce(
      hint({
        deliveryId: "d-toast",
        mode: "TOAST",
        ctaKind: "ROUTE",
        ctaLabel: "Открыть",
        ctaTarget: "/renew",
      }),
    );

    await render();
    await act(async () => {
      await Promise.resolve();
    });

    const action = toast()["action"] as { label: string; onClick: () => void };
    expect(action.label).toBe("Открыть");
    await act(async () => {
      action.onClick();
      // Pressing the action also closes the toast, so sonner fires `onDismiss`
      // on the way out. Without a latch that second call would overwrite
      // `acted` with `dismissed` — the outcome the panel would then keep.
      (toast()["onDismiss"] as () => void)();
      await Promise.resolve();
    });

    expect(navigateSpy).toHaveBeenCalledWith("/renew");
    expect(api.closeHint).toHaveBeenCalledTimes(1);
    expect(api.closeHint).toHaveBeenCalledWith("d-toast", "acted");
  });

  it("does not let a second hint stack on top of it", async () => {
    // Two hints at once is what this controller exists to prevent, and a toast
    // under a modal is still two.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
    });

    expect(api.markHintShown).not.toHaveBeenCalledWith("d-modal");
    expect(sonner.calls).toHaveLength(1);
  });

  it("comes back for a hint that was turned away while it was up", async () => {
    // The modal recovers on its own — dismissing it asks again. A toast can end
    // by simply running out of seconds, and that exit deliberately does not ask
    // again, or the customer gets one every eight seconds. Without remembering
    // that an ask WAS turned away, the hint raised during those eight seconds
    // waited for the next visit — and the hint raised mid-visit is the flagship
    // case this controller exists for: buying something.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase", key: "subscription-ready" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-purchase", key: "subscription-ready" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    // The purchase completes while the toast is still up: turned away.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
    });
    expect(api.markHintShown).not.toHaveBeenCalledWith("d-purchase");

    await act(async () => {
      (toast()["onAutoClose"] as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.markHintShown).toHaveBeenCalledWith("d-purchase");
  });

  it("does not go back for one when nothing was turned away", async () => {
    // The flag is the whole guard against this becoming an unconditional second
    // fetch — a toast every eight seconds is the nagging the design refuses.
    api.getNextHint.mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }));

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      (toast()["onAutoClose"] as () => void)();
      await Promise.resolve();
    });

    expect(api.getNextHint).toHaveBeenCalledTimes(1);
  });

  it("gives a toast with no button a way to say later", async () => {
    // Sonner's close button is small and easy to miss; without a labelled
    // control there is no way to tell the panel "not this" at all, and every
    // such hint would resolve as an expiry.
    api.getNextHint.mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }));

    await render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(toast()["closeButton"]).toBe(true);
    expect((toast()["cancel"] as { label: string }).label).toBe("hints.later");
  });
});

describe("the queue while a toast is on screen", () => {
  it("does not open a modal out of a toast that simply ran out", async () => {
    // THE STALE FLAG. `askSuppressed` records "a hint arrived while the screen
    // was busy, come back for it". It was set at the two turn-away points and
    // cleared in exactly one place — the drain — so an ask that SATISFIED it by
    // another route left it standing. The toast's expiry then drained a flag
    // that no longer meant anything and opened a modal minutes later, out of a
    // timeout the customer never touched: the exact nagging the expiry branch
    // exists to refuse.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d1" })) // modal takes the screen
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" })) // turned away
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" })) // shown on the re-ask
      .mockResolvedValueOnce(hint({ deliveryId: "d3" })); // must NOT appear
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The modal closes, which asks again and this time draws the toast. The
    // "later" button is the one control every hint modal has.
    const later = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "hints.later",
    );
    expect(later, "the hint modal is not on screen").toBeDefined();
    await act(async () => {
      later?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const asksBeforeExpiry = api.getNextHint.mock.calls.length;

    await act(async () => {
      (sonner.calls[0]?.options["onAutoClose"] as () => void)();
      await Promise.resolve();
    });

    expect(api.getNextHint).toHaveBeenCalledTimes(asksBeforeExpiry);
  });

  it("does not open one out of a flag set while the winning ask was in flight", async () => {
    // THE SAME PROHIBITION, BY THE PATH THE CASE ABOVE CANNOT REACH. That one
    // covers a flag set BEFORE an ask and cleared by it. This one is set
    // DURING one, which the clear-on-the-way-in could not see:
    //
    //   • a toast is on screen;
    //   • an ask leaves and stalls;
    //   • a second ask is raised, finds one already in flight, and records
    //     itself as suppressed — correctly, at that moment;
    //   • the stalled ask answers `null`. It drew nothing, so nothing is left
    //     to clear the flag, and no further ask will satisfy it either.
    //
    // The flag then stands for the rest of the visit, and the next toast to
    // simply run out of seconds drains it — opening a modal minutes later out
    // of a timeout the customer never touched, which is precisely what the
    // expiry branch refuses to do.
    let release: (value: unknown) => void = () => undefined;
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockReturnValueOnce(stalled)
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" })); // must NOT appear
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    // Two provisioning reports in the same tick: the first ask leaves and
    // stalls, the second finds it in flight and is recorded as suppressed.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The winner answers with nothing at all.
    await act(async () => {
      release(null);
      await Promise.resolve();
      await Promise.resolve();
    });
    const asksBeforeExpiry = api.getNextHint.mock.calls.length;

    await act(async () => {
      (sonner.calls[0]?.options["onAutoClose"] as () => void)();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      api.getNextHint,
      "a toast running out of seconds went back to the queue for a hint that had already been answered, and the answer this time was a modal the customer did nothing to ask for",
    ).toHaveBeenCalledTimes(asksBeforeExpiry);
    expect(api.markHintShown).not.toHaveBeenCalledWith("d-modal");
    expect(
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "hints.later",
      ),
      "a hint modal opened by itself out of an expiring toast",
    ).toBe(false);
  });

  it("keeps a toast from stacking under an open modal", async () => {
    // The TOAST branch's own slot guard, which had no case at all: the existing
    // stacking test puts the toast FIRST and the modal second, so it exercises
    // the modal guard. Without this one, deleting the toast branch's check let
    // a toast open under a modal — and its `openDeliveryId` overwrote the
    // modal's, so closing the toast released the slot while the modal was
    // still up.
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d1" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sonner.calls).toHaveLength(0);
    expect(api.markHintShown).not.toHaveBeenCalledWith("d-toast");
  });

  it("takes it off the screen when the shell goes away, reporting nothing", async () => {
    // `<Toaster>` is mounted outside the app shell, so a toast outlives its own
    // controller. On a sign-out it stayed on the sign-in screen with a button
    // that pushed an authenticated route through a `navigate` from the
    // torn-down tree — and because `openDeliveryId` died with the instance, a
    // remount could raise a second hint underneath it.
    //
    // Silent, because the app going away is not the customer saying no: a
    // dismissal here would destroy a hint they never answered.
    api.getNextHint.mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }));

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(() => root.unmount());

    expect(sonner.dismissed).toHaveLength(1);
    expect(api.closeHint).not.toHaveBeenCalled();
  });
});

describe("two asks that overlap", () => {
  it("makes one request, not two", async () => {
    // Six paths can start an ask. Two of them running together is one wasted
    // read of a queue that answers `null` almost every time — and the loser is
    // recorded as suppressed rather than dropped, so the winner's close comes
    // back for whatever it was going to fetch.
    let release: (value: unknown) => void = () => undefined;
    api.getNextHint.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.getNextHint).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(null);
      await Promise.resolve();
    });
  });

  it("never draws one delivery twice", async () => {
    // THE INTERLEAVING THE SLOT REF DOES NOT COVER. It stops two hints being up
    // at once; it does not stop the same hint being drawn twice in sequence.
    // Here the second ask is sent while the toast is up — so the queue, which
    // filters on `shownAt`, still offers the same row because the stamp has not
    // landed — and it resolves AFTER the toast has run out and released the
    // slot. The customer gets the same message twice, and it is stamped twice.
    let release: (value: unknown) => void = () => undefined;
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-toast", mode: "TOAST" }))
      .mockReturnValueOnce(stalled.then(() => hint({ deliveryId: "d-toast", mode: "TOAST" })));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    // The second ask leaves, and stalls.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The toast runs out, releasing the slot.
    await act(async () => {
      (sonner.calls[0]?.options["onAutoClose"] as () => void)();
      await Promise.resolve();
    });
    // Only now does the stalled read answer, with the row it was already given.
    await act(async () => {
      release(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sonner.calls).toHaveLength(1);
    expect(api.markHintShown).toHaveBeenCalledTimes(1);
  });
});

describe("under StrictMode, which is how the cabinet actually mounts", () => {
  it("stamps the hint it draws exactly once", async () => {
    // `main.tsx` wraps the app in StrictMode, which double-invokes effects and
    // state updaters in development and replays a discarded render. The stamp
    // is deliberately kept OUT of `setHint`'s updater for that reason — and the
    // case guarding it mounted with a bare root, so it could not have observed
    // a double invocation at all. Moving `markHintShown` back inside the
    // updater left it green.
    api.getNextHint.mockResolvedValueOnce(hint({ deliveryId: "d1" }));

    await act(async () => {
      root.render(
        <StrictMode>
          <HintController audience={AUDIENCE} />
        </StrictMode>,
      );
    });

    expect(api.markHintShown).toHaveBeenCalledTimes(1);
    expect(api.markHintShown).toHaveBeenCalledWith("d1");
  });
});

describe("acting on a toast", () => {
  it("does not open a modal on the page it just navigated to", async () => {
    // The modal path refuses this in as many words, and the toast path used to
    // do the opposite: acting NAVIGATES, so draining a suppressed hint here
    // opens a full-screen dialog on the page the customer was just sent to.
    // Same rule, two behaviours, decided only by which mode came first.
    api.getNextHint
      .mockResolvedValueOnce(
        hint({ deliveryId: "d-toast", mode: "TOAST", ctaKind: "ROUTE", ctaLabel: "Открыть", ctaTarget: "/renew" }),
      )
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" })) // turned away while the toast is up
      .mockResolvedValueOnce(hint({ deliveryId: "d-modal" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const asksBefore = api.getNextHint.mock.calls.length;

    await act(async () => {
      (sonner.calls[0]?.options["action"] as { onClick: () => void }).onClick();
      await Promise.resolve();
    });

    expect(navigateSpy).toHaveBeenCalledWith("/renew");
    expect(api.getNextHint).toHaveBeenCalledTimes(asksBefore);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("a toast that cannot be drawn at all", () => {
  it("leaves the queue moving instead of wedging it for the visit", async () => {
    // `showHintToast` can throw — the "later" label calls `t` unguarded while
    // the controller reads it as `useTranslation() ?? {}` — and the rejection is
    // swallowed by `void ask()`. With the slot claimed BEFORE the toast is up,
    // that left `openDeliveryId` set for ever: every later ask hit the guard and
    // returned, and no hint was drawn again until a full page reload.
    sonner.state.throwOnce = true;
    api.getNextHint
      .mockResolvedValueOnce(hint({ deliveryId: "d-broken", mode: "TOAST" }))
      .mockResolvedValueOnce(hint({ deliveryId: "d-next" }));
    api.reportHintMoment.mockResolvedValue(true);

    await render();
    await act(async () => {
      await Promise.resolve();
    });
    // The slot must be free, so the next ask draws normally.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("reiwa:subscription-provisioning-completed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.markHintShown).not.toHaveBeenCalledWith("d-broken");
    expect(api.markHintShown).toHaveBeenCalledWith("d-next");
  });
});
