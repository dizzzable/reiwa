import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CabinetHint } from "@/lib/api-client/hints";
import { cn } from "@/lib/utils";

/**
 * One operator-authored hint, on screen.
 *
 * ── Two buttons, and the second one is not optional ───────────────────────
 *
 * A modal whose only exit is its own call to action forces somebody who does
 * not want it to press "go" just to be rid of it — and we would then count
 * that as the hint working. The dismiss button is what keeps the two outcomes
 * distinguishable, which is the only thing that makes the numbers mean
 * anything.
 *
 * ── Why the tone is a stripe and not the whole dialog ─────────────────────
 *
 * These carry the same four tones as `TipCard`, but a modal painted entirely
 * in a warning colour reads as an error the customer caused. The colour sits on
 * a rule above the title: enough to set the register, not enough to alarm.
 */

const TONE_RULE: Record<CabinetHint["tone"], string> = {
  INFO: "bg-blue-500/70",
  SUCCESS: "bg-emerald-500/70",
  WARNING: "bg-amber-500/70",
  DANGER: "bg-(--brand-primary)/70",
};

export function HintModal({
  hint,
  surface,
  onAct,
  onDismiss,
}: {
  readonly hint: CabinetHint;
  /** Decides how an external link is opened — see `openExternal` below. */
  readonly surface: "tma" | "pwa" | "browser";
  readonly onAct: () => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  function openExternal(url: string): void {
    // Inside Telegram a plain `window.open` is either swallowed or drops the
    // customer into an in-app browser they cannot get back from. The Mini App
    // bridge is the supported way out, and the cabinet already knows which of
    // the three surfaces it is on — see `stealth-layout`.
    const webApp = (window as { Telegram?: { WebApp?: { openLink?: (u: string) => void } } })
      .Telegram?.WebApp;
    if (surface === "tma" && typeof webApp?.openLink === "function") {
      webApp.openLink(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function act(): void {
    if (hint.ctaKind === "ROUTE" && hint.ctaTarget) {
      void navigate(hint.ctaTarget);
    } else if (hint.ctaKind === "EXTERNAL" && hint.ctaTarget) {
      openExternal(hint.ctaTarget);
    }
    onAct();
  }

  const hasCta = hint.ctaKind !== "NONE" && hint.ctaTarget !== null && hint.ctaLabel !== null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Anything that closes the dialog WITHOUT the call to action — the X,
        // the overlay, Escape — is a dismissal. Counting those as successes is
        // how a hint nobody reads comes to look like the best one you have.
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="max-w-sm">
        <div className={cn("mb-1 h-1 w-10 rounded-full", TONE_RULE[hint.tone])} aria-hidden />
        <DialogHeader>
          <DialogTitle>{hint.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line text-left">
            {hint.body}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {hasCta && (
            <Button className="w-full" onClick={act}>
              {hint.ctaLabel}
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={onDismiss}>
            {/* Named "later", not "close": the hint may come back if it has not
                expired, and a label that promised otherwise would be a lie. */}
            {t("hints.later", { defaultValue: "Позже" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
