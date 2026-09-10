import { toast } from "sonner";
import type { NavigateFunction } from "react-router";
import type { TFunction } from "i18next";

import type { CabinetHint } from "@/lib/api-client/hints";

import { hasHintCta, runHintCta } from "./hint-cta";
import { severityForTone, type HintToastSeverity } from "./hint-tone";

/**
 * A hint that does not interrupt.
 *
 * ── Why the cabinet needed a second way to draw one ──────────────────────────
 *
 * It could draw exactly one: a modal. Everything an operator wanted to say
 * therefore arrived as a full-screen dialog over whatever the customer was
 * doing — including the things that are merely nice to know. Two of the
 * ready-made pop-ups were written as toasts, could not be created at all
 * because of it, and were rewritten as modals. A library of thirty is thirty
 * ways to interrupt somebody if this stays the only mode.
 *
 * The rule the two modes divide on: a MODAL is for something that needs a
 * decision or has gone wrong; a TOAST is for something worth knowing while the
 * person carries on. "Your payment did not go through" stops the world. "Your
 * trial has started" does not.
 *
 * ── An auto-close is NOT a dismissal ─────────────────────────────────────────
 *
 * This is the whole reason the outcome handling below is not symmetrical. A
 * dismissal is a decision — the customer looked and said no — and the panel
 * treats it as one: a dismissed delivery never comes back. A toast that simply
 * ran out of seconds while somebody was reading the page carries no decision at
 * all, so reporting one would be inventing an answer on their behalf and
 * destroying a hint they may not have read.
 *
 * Nothing is reported in that case, and nothing needs to be: `markHintShown`
 * has already run, and the queue filters on `shownAt`, so the hint leaves the
 * queue by having been shown rather than by being marked refused.
 */

/** Sonner's four calls, by severity. The tone → severity decision is in `hint-tone.ts`. */
const SEVERITY_TOAST: Record<HintToastSeverity, (message: string, options?: object) => unknown> = {
  info: toast.info,
  success: toast.success,
  warning: toast.warning,
  error: toast.error,
};

/**
 * Long enough to read a sentence and a half.
 *
 * Sonner's default is four seconds, which is written for "Saved" — a hint
 * carries a title AND a body, and a message that leaves before it has been read
 * is a delivery spent for nothing. Eight is measured against the longest body
 * the panel accepts rather than against taste.
 */
const TOAST_MS = 8_000;

export function showHintToast(options: {
  readonly hint: CabinetHint;
  readonly t: TFunction;
  readonly navigate: NavigateFunction;
  /** The customer pressed the call to action. */
  readonly onAct: () => void;
  /** The customer closed it deliberately. */
  readonly onDismiss: () => void;
  /** It closed on its own. No decision was made and none is reported. */
  readonly onExpire: () => void;
  /**
   * Takes it off the screen reporting nothing, for the caller to keep.
   *
   * `<Toaster>` lives outside the app shell, so a toast outlives the component
   * that raised it unless somebody dismisses it. That dismissal must be silent:
   * sonner calls `onDismiss` for a programmatic `toast.dismiss` exactly as it
   * does for the ✕ button, and a sign-out is not the customer saying no.
   */
}): () => void {
  const { hint, t, navigate, onAct, onDismiss, onExpire } = options;
  const raise = SEVERITY_TOAST[severityForTone(hint.tone)];

  // Whichever of the three outcomes happens first wins. Sonner calls
  // `onDismiss` for a close AND `onAutoClose` for a timeout, and pressing the
  // action closes the toast — which fires `onDismiss` on the way out. Without
  // this latch, acting would report `acted` and then `dismissed` for the same
  // delivery, and the second write is the one the panel would keep.
  let settled = false;
  const once = (run: () => void) => () => {
    if (settled) return;
    settled = true;
    run();
  };

  const id = raise(hint.title, {
    description: hint.body,
    duration: TOAST_MS,
    // The customer can always end it deliberately, which is what makes the
    // difference between "dismissed" and "expired" a real one rather than a
    // distinction only this file believes in.
    closeButton: true,
    ...(hasHintCta(hint)
      ? {
          action: {
            label: hint.ctaLabel as string,
            onClick: once(() => {
              runHintCta(hint, navigate);
              onAct();
            }),
          },
        }
      : {}),
    // Named "later" for the same reason the modal's button is: the hint may
    // come back if it has not expired, and a label promising otherwise would be
    // a lie. Only used when there is no call to action, so the toast is never
    // wider than it needs to be.
    ...(hasHintCta(hint)
      ? {}
      : { cancel: { label: t("hints.later"), onClick: once(onDismiss) } }),
    onDismiss: once(onDismiss),
    onAutoClose: once(onExpire),
  });

  return () => {
    // Latch first, dismiss second. The other order reports a dismissal the
    // customer never made — and a dismissed delivery never comes back.
    settled = true;
    toast.dismiss(id as string | number);
  };
}
