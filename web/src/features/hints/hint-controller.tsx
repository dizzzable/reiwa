import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import {
  closeHint,
  getNextHint,
  markHintShown,
  reportHintMoment,
  type CabinetHint,
  type HintDevice,
} from "@/lib/api-client/hints";
import { reportClientError } from "@/lib/client-error-reporter";
import { useOnboardingContext } from "@/features/onboarding/onboarding-tour-controller";
import { mustWaitForTour } from "@/features/push-prompt/push-prompt-policy";
import { SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT } from "@/lib/subscription-provisioning-receipt";

import { setHintOnScreen } from "./hint-presence";
import { HintModal } from "./hint-modal";
import { showHintToast } from "./hint-toast";

/**
 * When the controller looks at the queue again after the ask on entry,
 * measured from the mount.
 *
 * ── Why it looks again at all ─────────────────────────────────────────────
 *
 * The welcome pop-up is not written by the sign-up request. The panel's
 * registration handler emits an event, and an automation job writes the
 * delivery a fraction of a second to a few seconds later — by which time the
 * new customer has been navigated into the cabinet, the shell has mounted, and
 * the one ask on entry has been answered `null`. The welcome then waited for
 * their NEXT visit: the one hint written for this exact moment arrived just
 * after it.
 *
 * ── Why after every mount, and not only after a sign-in ───────────────────
 *
 * There is no single place in this SPA that every sign-in passes. Google,
 * Yandex and the site's Telegram button come back through a SERVER redirect
 * that lands the browser straight on `/dashboard` (`auth/ext/:provider/
 * callback`), and that page load cannot be told apart from a returning
 * customer opening a bookmark. A marker left by the sign-in pages would miss
 * exactly those paths, silently. Two more reads of a queue that answers `null`
 * almost every time is the cheaper mistake.
 *
 * ── Why two, and never a third ────────────────────────────────────────────
 *
 * Four seconds covers the ordinary automation; fifteen covers a slow queue.
 * Then it stops for the life of the page: whatever is raised later is found by
 * the next thing that happens, or by the next visit.
 */
const FOLLOW_UP_ASK_DELAYS_MS = [4_000, 15_000] as const;

/**
 * Draws at most one queued hint at a time.
 *
 * ── Why one, and why not on every navigation ──────────────────────────────
 *
 * A customer can accumulate several: one purchase through a referral link with
 * a promo code emits four events within seconds, and somebody away for a
 * fortnight comes back to whatever happened while they were gone. Showing them
 * all would mean a modal on every screen they walk through, which is how people
 * learn to close hints without reading them — and then the useful ones go too.
 *
 * So it asks on entry — plus at most two follow-ups in the first seconds of the
 * visit, see `FOLLOW_UP_ASK_DELAYS_MS` — and again only when something HAPPENS
 * that could have queued one. Polling would turn a convenience into a nag.
 *
 * ── The one thing that happens mid-visit ──────────────────────────────────
 *
 * Buying. The customer returns from the payment page, the cabinet polls until
 * the new subscription's profile is usable, and that instant — the end of the
 * poll — is the whole reason this feature exists. It is not a server event and
 * there is nothing upstream to wait for: it exists only in this browser, so the
 * client reports it and immediately asks again.
 *
 * Without the second ask the flagship case would show its hint on the customer's
 * NEXT visit, which is not "leading them by the hand" in any useful sense.
 */
export function HintController({ audience }: { readonly audience: HintDevice | null }) {
  // Read defensively. This component sits in the cabinet SHELL, wrapping every
  // authenticated page, and it is the least important thing on any of them — a
  // hint. Anything it touches that could be absent must degrade to "no hint"
  // rather than take the whole layout down with it, and a language lookup is
  // not worth a blank screen.
  const { t, i18n } = useTranslation() ?? {};
  const navigate = useNavigate();
  const [hint, setHint] = useState<CabinetHint | null>(null);
  /** Guards the mount ask against React StrictMode's double invocation. */
  const askedOnMount = useRef(false);
  const alive = useRef(true);
  /**
   * The delivery currently on screen, or `null`.
   *
   * Deliberately a ref and not derived from `hint`: `ask` has to know whether a
   * modal is up BEFORE it stamps one as shown, and reading that from state
   * inside an async callback gives the value captured when the callback was
   * created, not the value now.
   */
  const openDeliveryId = useRef<string | null>(null);
  /** One attempt per visit at clearing a hint this build cannot draw. */
  const skippedUndrawable = useRef(false);
  /**
   * An ask that was turned away because something was already on screen.
   *
   * The modal recovers on its own: dismissing it asks again. A toast does not —
   * it can end by simply running out of seconds, and that exit deliberately
   * does NOT ask again, or the customer gets one every eight seconds. Without
   * this, a hint raised during those eight seconds waited for their next visit,
   * and the hint raised mid-visit is the flagship case this whole controller
   * exists for: buying something.
   */
  const askSuppressed = useRef(false);
  /**
   * `ask`, reachable from callbacks defined before it.
   *
   * `drainSuppressed` is used INSIDE `ask` (through the toast's handlers) and
   * would otherwise have to be declared after it, which the toast branch cannot
   * wait for. A ref keeps one definition of each rather than a second copy of
   * the asking.
   */
  const askRef = useRef<((followUp?: boolean) => Promise<void>) | null>(null);

  /**
   * One fetch at a time. See the guard at the top of `ask`.
   */
  const asking = useRef(false);

  /**
   * The fetch in flight was started by a follow-up — a clock, not something
   * that happened. See the guard at the top of `ask` for why that matters.
   *
   * Read only while `asking` is set, and every ask writes it as it sets
   * `asking`, so it never needs clearing on the way out.
   */
  const followUpInFlight = useRef(false);

  /**
   * Something happened while a follow-up's fetch was in flight, so that fetch
   * cannot be its answer: ask again the moment it comes back.
   */
  const askAfterFollowUp = useRef(false);

  /**
   * Deliveries this visit has already put on screen.
   *
   * The slot ref stops two hints being up AT ONCE; it does not stop the same
   * hint being drawn twice in sequence, and one interleaving does exactly that:
   * a toast is showing when a second ask starts, the toast runs out and
   * releases the slot, and the second ask — which asked BEFORE the stamp
   * landed, so the queue still offered the same row — then draws it again and
   * stamps it a second time. The customer sees the same message twice for one
   * event.
   *
   * Filled only where a hint is actually drawn, so a delivery that was turned
   * away is still free to arrive later.
   */
  const drawn = useRef(new Set<string>());

  /**
   * How to take the toast off the screen when this controller goes away.
   *
   * `<Toaster>` is mounted in `main.tsx`, OUTSIDE the app shell, so a toast
   * raised here survives its own controller: on a sign-out the shell unmounts
   * and the hint stayed on the sign-in screen for the rest of its eight
   * seconds, with a button that pushed an authenticated route through a
   * `navigate` captured from the torn-down tree. Worse, `openDeliveryId` dies
   * with the instance, so a remount could raise a second hint underneath the
   * orphaned one — the two-at-once this controller exists to prevent.
   */
  const openToast = useRef<(() => void) | null>(null);

  // ── THE TUTORIAL GOES FIRST ───────────────────────────────────────────
  //
  // Read through the context's own default when the provider is missing, so
  // this stays the component that degrades to "no hint" rather than taking a
  // page down. `mustWaitForTour` is the push prompt's rule, reused rather
  // than restated: the two things that can appear over a fresh dashboard now
  // queue behind the tour identically.
  const tour = useOnboardingContext();
  const tourIsBusy = mustWaitForTour({
    tourActive: tour.isActive,
    tourPending: tour.autoStartPending,
  });
  /** The answer above, reachable from inside `ask`'s async body. */
  const tourBusy = useRef(tourIsBusy);
  tourBusy.current = tourIsBusy;
  /**
   * An ask that was turned away because the tour was on screen or due.
   *
   * Deliberately NOT `askSuppressed`: that flag means "another hint held the
   * screen", it is cleared by any later ask's read, and the tour can outlast
   * several of those. This one is cleared in exactly one place — the effect
   * that watches the tour let go.
   */
  const waitingForTour = useRef(false);

  /**
   * Claim and release the one on-screen slot.
   *
   * The ref and the flag the tour reads (`hint-presence.ts`) MUST move
   * together. A flag left set after a hint closed holds the tutorial back for
   * the rest of the visit; a flag left clear under an open hint puts the
   * spotlight straight over it — the defect this whole pair exists to fix.
   * Seven places set this ref, which is seven chances to update one and not
   * the other, so neither is written directly any more.
   */
  const claimSlot = useCallback((deliveryId: string): void => {
    openDeliveryId.current = deliveryId;
    setHintOnScreen(true);
  }, []);
  const releaseSlot = useCallback((): void => {
    openDeliveryId.current = null;
    setHintOnScreen(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // The slot goes with it. `openDeliveryId` dies with the instance, but
      // the flag the tour reads is a module and does not — a sign-out with a
      // hint on screen left the tutorial permanently held back.
      releaseSlot();
      // Reports NOTHING, by design — see `dismissSilently` in `hint-toast`.
      // The customer did not close this; the app went away underneath it, and
      // recording a dismissal would destroy a hint they never answered.
      openToast.current?.();
      openToast.current = null;
    };
  }, [releaseSlot]);

  /**
   * Come back for a hint that was turned away while the screen was busy.
   *
   * Only when one actually was: the flag is set at the two places `ask` returns
   * early for that reason, so this cannot become an unconditional second fetch.
   */
  const drainSuppressed = useCallback(() => {
    if (!askSuppressed.current || !alive.current) return;
    askSuppressed.current = false;
    void askRef.current?.();
  }, []);

  const ask = useCallback(async (followUp = false) => {
    if (audience === null) return;

    // ── NOTHING IS DRAWN UNDER THE TUTORIAL ──────────────────────────────
    //
    // The hint worth showing most — «Готово! Подписка оформлена», with the
    // «Подключиться» that is the whole point of it — is raised by the same
    // moment the tour has been waiting for: a purchase finishing. They drew
    // together, and the spotlight dimmed the modal it could not see.
    //
    // Returned BEFORE the fetch, so nothing is stamped shown and nothing is
    // lost: the queue still holds it, and the effect below comes back for it
    // the moment the tour is over or turns out not to be due.
    if (tourBusy.current) {
      waitingForTour.current = true;
      return;
    }

    // ── ONE ASK AT A TIME ────────────────────────────────────────────────
    //
    // `getNextHint` is a pure read and the queue filters on `shownAt: null`,
    // so two asks in flight together are handed the SAME head-of-queue row —
    // and both then draw it and both stamp it shown. Seven separate paths can
    // start an ask (mount, the follow-ups, provisioning, a modal close, a
    // toast close, the undrawable retry, a drain), and until this guard
    // existed nothing stopped two of them overlapping.
    //
    // The loser is recorded as suppressed rather than dropped, so the winner's
    // close comes back for whatever it was going to fetch.
    if (asking.current) {
      // …EXCEPT behind a follow-up. Every other fetch left because something
      // happened, so an ask raised during it is satisfied by its answer. A
      // follow-up's fetch left on a CLOCK, possibly before the purchase that
      // raised this ask was even written — and the follow-ups sit in the first
      // seconds of a visit, which is exactly when a customer back from the
      // payment page finishes provisioning. Counted as answered, the flagship
      // hint waited for the next visit, reintroduced by the feature that exists
      // to stop hints arriving late.
      if (followUpInFlight.current && !followUp) {
        askAfterFollowUp.current = true;
        return;
      }
      askSuppressed.current = true;
      return;
    }
    asking.current = true;
    followUpInFlight.current = followUp;

    let next;
    try {
      next = await getNextHint({
        ...audience,
        locale: i18n?.language === "en" ? "en" : "ru",
      });
    } finally {
      asking.current = false;
    }

    // The follow-up's answer is DISCARDED, not drawn. The ask that came in
    // behind it needs a read issued after whatever raised it, and that read
    // hands back this same row if it is still first in line — nothing was
    // stamped, so nothing is lost. If the row has left the queue in between
    // (shown in another tab, say), the fresher read is the one that knows.
    // Not after an unmount: nobody is left to answer.
    if (askAfterFollowUp.current) {
      askAfterFollowUp.current = false;
      if (alive.current) void askRef.current?.();
      return;
    }

    // CLEARED AFTER THE READ, not before it — and this is the whole of the
    // second defect. Clearing it on the way IN satisfied only the asks that had
    // already been deferred; an ask turned away DURING this one's await set the
    // flag again, and if this one then returned nothing there was no draw left
    // to clear it and no second read to satisfy it. The flag stood for the rest
    // of the visit, and the next toast to simply run out of seconds drained it
    // — opening a modal minutes later, out of a timeout the customer never
    // touched, which is exactly the nagging the expiry branch refuses.
    //
    // What clearing it here does NOT promise. An ask deferred BEFORE this read
    // left is answered by it: the read was issued after that ask was raised.
    // An ask turned away DURING this one's await is counted as answered too,
    // by a read that may predate whatever raised it — a purchase written a
    // moment after this read left is simply not in it. Keeping the flag for
    // that ask would bring back the stale flag above, so the case stays open
    // on purpose: in the first seconds of a visit a follow-up still due picks
    // it up, provided nothing has been drawn; after that it waits for the next
    // thing that happens, or for the next visit. (An ask raised by something
    // that happened is never counted as answered by a FOLLOW-UP's read — see
    // `askAfterFollowUp` above.)
    //
    // The two guards below re-arm the flag if THIS ask is itself turned away,
    // which is the only case where somebody must come back.
    askSuppressed.current = false;
    // A hint fetched into a component that has since unmounted must not be
    // stamped as shown — the customer never saw it, and the stamp is the only
    // thing that stops it coming back.
    //
    // `undefined` as well as `null`: the client returns `r.data.hint`, so a 200
    // whose body is not the shape we expect — an edge interstitial, an SPA
    // rewrite catching the API path — yields undefined, and dereferencing it
    // took the layout down rather than degrading to no hint.
    if (!alive.current || next === null || next === undefined) return;

    // ── A MODE THIS BUILD CANNOT DRAW IS CLOSED, NOT SKIPPED ──────────────
    //
    // Returning silently left the row unshown, undismissed and unexpired, so
    // `nextFor` — which orders by `createdAt` ascending — handed back the SAME
    // row on every later ask, for up to ninety days. That is the starvation the
    // audience filter was moved into SQL to eliminate, reintroduced on the
    // client: one `TOAST` hint authored after a panel upgrade would block every
    // later hint, a failed-payment one included, for anybody still running a
    // cached bundle that predates it. Closing it costs one delivery and keeps
    // the queue moving, which is the cheaper of the two mistakes.
    // ── A TOAST does not take the screen, so it does not take the slot ────
    //
    // The rule the two modes divide on: a modal is for something that needs a
    // decision or has gone wrong; a toast is for something worth knowing while
    // the person carries on. It is still stamped shown, and the queue filters
    // on that, so it leaves the queue the same way a modal does.
    //
    // It DOES hold `openDeliveryId` while it is up, for the same reason a modal
    // does: two hints at once is the thing this controller exists to prevent,
    // and a toast stacking under a modal is still two.
    if (drawn.current.has(next.deliveryId)) return;

    if (next.mode === 'TOAST') {
      if (openDeliveryId.current !== null) {
        askSuppressed.current = true;
        return;
      }
      // CLAIMED AFTER THE TOAST IS UP, not before. `showHintToast` can throw —
      // `t` is read as `useTranslation() ?? {}` and the "later" label calls it
      // unguarded — and the rejection is swallowed by `void ask()`. With the
      // slot claimed first, that left `openDeliveryId` set for ever: every
      // later ask hit the guard and returned, and no hint was drawn again until
      // a full page reload. Silent, total, and one `??` away.
      let dismissToast: (() => void) | null = null;
      try {
        dismissToast = showHintToast({
        hint: next,
        t,
        navigate,
        onAct: () => {
          void closeHint(next.deliveryId, 'acted');
          releaseSlot();
          openToast.current = null;
          // NOT drained, and the modal path says why: acting NAVIGATES, and a
          // dialog opening on the page somebody was just sent to is the nagging
          // this design refuses. Draining here made the same rule behave two
          // ways depending only on which mode the first hint happened to be.
          //
          // Nothing is lost: a hint turned away while this toast was up is
          // still queued, and the next ask — the next visit, or the next
          // provisioning — finds it.
        },
        onDismiss: () => {
          void closeHint(next.deliveryId, 'dismissed');
          releaseSlot();
          openToast.current = null;
          // Asked again on a deliberate close only, exactly as the modal does:
          // a hint raised while an older one was on screen would otherwise wait
          // for the customer's next visit.
          //
          // Through the ref rather than the captured `ask`: this callback was
          // built when the toast was raised and holds that render's locale and
          // audience. A customer who switches language while a toast is up
          // would otherwise get the next hint in the language they just left.
          if (alive.current) void askRef.current?.();
        },
        onExpire: () => {
          // No outcome is reported. Running out of seconds is not a decision,
          // and recording it as a dismissal would destroy a hint the customer
          // may not have read. Nor do we ask again — a toast every eight
          // seconds is the nagging this design refuses.
          releaseSlot();
          openToast.current = null;
          // …but a hint that ARRIVED while it was up is a different matter: it
          // was turned away, not shown, and nothing else in the visit would
          // ever come back for it.
          drainSuppressed();
        },
        });
      } catch (error) {
        // The slot was never claimed, so the queue keeps moving. Reported
        // rather than swallowed: a toast that cannot be built is a defect in
        // this build, not something the customer did.
        reportClientError({
          message: `hint toast failed to render: ${(error as Error)?.message ?? String(error)}`,
          stack: (error as Error)?.stack,
          kind: 'hint.toast',
        });
        return;
      }

      claimSlot(next.deliveryId);
      drawn.current.add(next.deliveryId);
      openToast.current = dismissToast;
      void markHintShown(next.deliveryId);
      return;
    }

    if (next.mode !== 'MODAL') {
      // ── BOUNDED, because the close can fail and say nothing ───────────────
      //
      // `closeHint` swallows its own errors and the route answers 200 `{ok:
      // false}` when the write does not land, so this promise resolves the same
      // way whether or not anything changed. Unbounded, a healthy read path
      // beside a degraded write path becomes a loop: `next` keeps returning the
      // same row, `closed` keeps failing, and the browser spends the customer's
      // whole rate-limit budget — after which every OTHER cabinet request 429s.
      // A mitigation for a stale bundle would have become a self-inflicted
      // outage.
      //
      // One retry is all this needs: the point is to unblock a queue head that
      // this build cannot draw, and if the close did not take, the next visit
      // tries again at no cost.
      if (skippedUndrawable.current) return;
      skippedUndrawable.current = true;
      void closeHint(next.deliveryId, 'dismissed').then(() => {
        if (alive.current) void ask();
      });
      return;
    }

    // ── DECIDED BEFORE THE STAMP, AND NOT INSIDE THE UPDATER ──────────────
    //
    // `openDeliveryId` is the guard, and it has to be a ref. Putting the check
    // inside `setHint`'s updater and the stamp after it meant a hint the
    // updater THREW AWAY — because a modal was already open — was still marked
    // shown. `nextFor` filters on `shownAt: null`, so that delivery became
    // permanently invisible: never drawn, never re-offered, and for a
    // non-repeatable hint never raised again either. The purchase hint arriving
    // while an older modal was still up died exactly this way.
    //
    // The stamp stays outside any updater regardless: React double-invokes
    // updaters under StrictMode and replays them when a render is discarded, so
    // a side effect in there fires more than once per hint.
    if (openDeliveryId.current !== null) {
      askSuppressed.current = true;
      return;
    }
    claimSlot(next.deliveryId);
    drawn.current.add(next.deliveryId);
    setHint(next);
    void markHintShown(next.deliveryId);
  }, [audience, claimSlot, i18n?.language, navigate, releaseSlot, t]);

  askRef.current = ask;

  // ── THE TUTORIAL LET GO ───────────────────────────────────────────────
  //
  // It finished, was skipped, or turned out not to be due at all — and this
  // is where the hint it held comes back. No polling and no timer: the
  // provider re-renders this controller whenever the tour starts, stops or
  // stops being due, which is exactly the push prompt's arrangement.
  //
  // Guarded on the flag, so this is not an unconditional second fetch on
  // every tour transition for the customers — most of them — who had no hint
  // waiting.
  useEffect(() => {
    if (tourIsBusy || !waitingForTour.current) return;
    waitingForTour.current = false;
    if (alive.current) void askRef.current?.();
  }, [tourIsBusy]);

  useEffect(() => {
    if (audience === null || askedOnMount.current) return;
    askedOnMount.current = true;
    void ask();
  }, [audience, ask]);

  // ── TWO FOLLOW-UPS PER MOUNT, ONLY WHILE NOTHING HAS BEEN DRAWN ──────────
  //
  // `FOLLOW_UP_ASK_DELAYS_MS` says why they exist. This is how they stay
  // bounded.
  //
  // Armed ONCE PER MOUNT, deliberately with no dependencies. `ask` gets a new
  // identity on every page the customer moves to — react-router hands down a
  // new `navigate` for each pathname — and on a language switch, and
  // `audience` can get one when the session is refetched. Re-arming on any of
  // them would turn "two follow-ups" into two more after every navigation: a
  // poll with extra steps. The timers reach `ask` through the ref instead, for
  // the reason the toast's handlers do: the locale at the moment they fire,
  // not the one captured at mount.
  //
  // "Nothing drawn this visit" is the whole condition, and it covers "nothing
  // on screen" too, since only this controller puts a hint there. A toast that
  // simply ran out of seconds still counts as drawn: asking after it would be
  // the nagging its expiry refuses, and after `acted` it would open a hint on
  // the page the customer was just sent to.
  //
  // Cleared on unmount, so a sign-out never asks on behalf of a session that is
  // gone. Under StrictMode the rehearsal unmount clears the first pair and the
  // real mount arms the only pair that fires.
  useEffect(() => {
    const timers = FOLLOW_UP_ASK_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        if (drawn.current.size > 0) return;
        void askRef.current?.(true);
      }, delay),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onProvisioningCompleted = () => {
      void reportHintMoment("subscription-ready").then((raised) => {
        // Only re-ask when something was actually queued. "Once" means a repeat
        // purchase raises nothing, and asking again on that would show whatever
        // unrelated hint happens to be at the head of the queue at the least
        // welcome moment.
        if (raised) void ask();
      });
    };

    // ── A DEDICATED SUCCESS EVENT, not a transition on the receipt map ──
    //
    // This listened for "any receipt pending" going true to false, and that was
    // wrong twice over. The same clear runs when a payment FAILS or is
    // cancelled, so the customer whose card was just declined met "your
    // subscription is ready, here is how to connect". And a second, abandoned
    // receipt left `pending` true straight through a real completion, so the
    // flagship hint was never raised at all — the one case this exists for.
    window.addEventListener(SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT, onProvisioningCompleted);
    return () => {
      window.removeEventListener(
        SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT,
        onProvisioningCompleted,
      );
    };
  }, [ask]);

  if (hint === null || audience === null) return null;

  return (
    <HintModal
      hint={hint}
      onAct={() => {
        void closeHint(hint.deliveryId, "acted");
        // Released together, always. `openDeliveryId` is what lets the next ask
        // through; leaving it set would wedge the controller on the first hint
        // of the visit as surely as the old state check did.
        releaseSlot();
        setHint(null);
      }}
      onDismiss={() => {
        void closeHint(hint.deliveryId, "dismissed");
        releaseSlot();
        setHint(null);
        // Asked again on DISMISS only. A hint raised while an older one was on
        // screen was otherwise deferred to the customer's next visit, which is
        // exactly the delay this feature exists to avoid. Not after `acted`,
        // because that navigates — a modal opening on the page they were just
        // sent to is the nagging this design refuses.
        void ask();
      }}
    />
  );
}
