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
import {
  listSubscriptionProvisioningReceipts,
  SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
} from "@/lib/subscription-provisioning-receipt";

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
  /** True while a purchase is still being provisioned. */
  const pendingProvisioning = useRef(listSubscriptionProvisioningReceipts().length > 0);
  const alive = useRef(true);

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
    setHint((current) => {
      // Never replace one the customer is already reading. The queue keeps its
      // order; whatever arrived can wait for the modal to close.
      if (current !== null) return current;
      void markHintShown(next.deliveryId);
      return next;
    });
  }, [audience, i18n?.language]);

  useEffect(() => {
    if (audience === null || askedOnMount.current) return;
    askedOnMount.current = true;
    void ask();
  }, [audience, ask]);

  useEffect(() => {
    const onReceiptsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ readonly hasPendingProvisioning?: unknown }>).detail;
      const pending =
        typeof detail?.hasPendingProvisioning === "boolean"
          ? detail.hasPendingProvisioning
          : listSubscriptionProvisioningReceipts().length > 0;

      // The TRANSITION is the moment, not the state. Reacting to `pending ===
      // false` on its own would fire on every receipt change for a customer who
      // never bought anything, which is most of them.
      const justFinished = pendingProvisioning.current && !pending;
      pendingProvisioning.current = pending;
      if (!justFinished) return;

      void reportHintMoment("subscription-ready").then((raised) => {
        // Only re-ask when something was actually queued. "Once" means a repeat
        // purchase raises nothing, and asking again on that would show whatever
        // unrelated hint happens to be at the head of the queue at the least
        // welcome moment.
        if (raised) void ask();
      });
    };

    window.addEventListener(SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT, onReceiptsChanged);
    return () => {
      window.removeEventListener(
        SUBSCRIPTION_PROVISIONING_RECEIPTS_CHANGED_EVENT,
        onReceiptsChanged,
      );
    };
  }, [ask]);

  if (hint === null || audience === null) return null;

  // MODAL is the only mode the cabinet draws today. The panel refuses to save
  // any other, but a hint authored before a mode was withdrawn — or by a newer
  // panel against an older cabinet — must render as nothing rather than as a
  // blank overlay the customer cannot dismiss.
  if (hint.mode !== "MODAL") return null;

  return (
    <HintModal
      hint={hint}
      surface={audience.surface}
      onAct={() => {
        void closeHint(hint.deliveryId, "acted");
        setHint(null);
      }}
      onDismiss={() => {
        void closeHint(hint.deliveryId, "dismissed");
        setHint(null);
      }}
    />
  );
}
