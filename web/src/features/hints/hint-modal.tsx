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

import { hasHintCta, runHintCta } from "./hint-cta";
import { railForTone } from "./hint-tone";

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
 *
 * The table itself is in `hint-tone.ts`, next to the toast's severity table,
 * because "what does an unrecognised tone become?" is one decision and the two
 * had drifted into answering it differently.
 */

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
    // `hint-cta.ts`, shared with the toast. The decision about what a hint's
    // button does is one decision, and this file used to hold a second copy of
    // half of it — a local external opener that got Telegram wrong.
    runHintCta(hint, navigate);
    onAct();
  }

  const hasCta = hasHintCta(hint);

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
        <div className={cn("mb-1 h-1 w-10 rounded-full", railForTone(hint.tone))} aria-hidden />
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
