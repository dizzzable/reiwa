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
import { cn, openExternalUrl } from "@/lib/utils";

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
  onAct,
  onDismiss,
}: {
  readonly hint: CabinetHint;
  readonly onAct: () => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  function act(): void {
    if (hint.ctaKind === "ROUTE" && hint.ctaTarget) {
      void navigate(hint.ctaTarget);
    } else if (hint.ctaKind === "EXTERNAL" && hint.ctaTarget) {
      // THE SHARED OPENER, not a local re-implementation. This file had one,
      // and it got Telegram wrong in the way this codebase has documented
      // twice: `openLink` on a `t.me` address shows the landing page in an
      // in-app browser instead of resolving it natively — and "open our bot" is
      // the most likely external destination an operator will ever author.
      // `openExternalUrl` classifies the link and picks `openTelegramLink` for
      // those, and it is the only copy of that decision.
      openExternalUrl(hint.ctaTarget);
    }
    onAct();
  }

  // `ROUTE` and `EXTERNAL` only. A kind a newer panel introduces would
  // otherwise render a full-width primary button that does nothing, closes the
  // modal and reports `acted` — a dead control counted as the hint working.
  const hasCta =
    (hint.ctaKind === "ROUTE" || hint.ctaKind === "EXTERNAL") &&
    typeof hint.ctaTarget === "string" &&
    hint.ctaTarget.length > 0 &&
    typeof hint.ctaLabel === "string" &&
    hint.ctaLabel.length > 0;

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
        {/* Falls back rather than rendering a colourless stripe: a tone this
            build has not heard of is a newer panel, not a broken hint. */}
        <div
          className={cn("mb-1 h-1 w-10 rounded-full", TONE_RULE[hint.tone] ?? TONE_RULE.INFO)}
          aria-hidden
        />
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
            {/* Named "later", not "close": the hint may come back if it has
                not expired, and a label promising otherwise would be a lie.
                The key is DEFINED now — it was not, so i18next fell through to
                its default and every English customer read a Russian word on
                the one button this dialog always has. */}
            {t("hints.later")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
