import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  closeHint,
  getNextHint,
  markHintShown,
  reportHintMoment,
  type CabinetHint,
  type HintDevice,
} from "@/lib/api-client/hints";
import { SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT } from "@/lib/subscription-provisioning-receipt";

import { HintModal } from "./hint-modal";

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
 * So it asks on entry, and again only when something HAPPENS that could have
 * queued one. Polling would turn a convenience into a nag.
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
  const { i18n } = useTranslation() ?? {};
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

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ask = useCallback(async () => {
    if (audience === null) return;
    const next = await getNextHint({
      ...audience,
      locale: i18n?.language === "en" ? "en" : "ru",
    });
    // A hint fetched into a component that has since unmounted must not be
    // stamped as shown — the customer never saw it, and the stamp is the only
    // thing that stops it coming back.
    if (!alive.current || next === null) return;

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
    if (openDeliveryId.current !== null) return;
    openDeliveryId.current = next.deliveryId;
    setHint(next);
    void markHintShown(next.deliveryId);
  }, [audience, i18n?.language]);

  useEffect(() => {
    if (audience === null || askedOnMount.current) return;
    askedOnMount.current = true;
    void ask();
  }, [audience, ask]);

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
        openDeliveryId.current = null;
        setHint(null);
      }}
      onDismiss={() => {
        void closeHint(hint.deliveryId, "dismissed");
        openDeliveryId.current = null;
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
