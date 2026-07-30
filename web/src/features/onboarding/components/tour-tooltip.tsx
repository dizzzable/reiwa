/**
 * TourTooltip
 * ───────────
 * Floating tooltip rendered next to the spotlight target during the
 * onboarding tour. Shows step title, body text, and navigation buttons
 * (Back / Next / Skip / Finish).
 *
 * Positioned below the spotlight rect by default; flips above when the
 * target is in the lower half of the viewport.
 */

import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

interface TourTooltipProps {
  title: string;
  body: string;
  step: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  /** Vertical position hint: "below" or "above" the spotlight. */
  position?: "below" | "above";
}

export function TourTooltip({
  title,
  body,
  step,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
  position = "below",
}: TourTooltipProps) {
  const { t } = useTranslation();
  const isFirst = step === 0;
  const isLast = step === totalSteps - 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: position === "below" ? -8 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: position === "below" ? -8 : 8 }}
      transition={{ duration: 0.2 }}
      className="fixed left-4 right-4 z-[9999] mx-auto max-w-sm rounded-2xl border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface-high)] p-5 shadow-2xl backdrop-blur-xl"
      style={{
        [position === "below" ? "top" : "bottom"]: "auto",
        ...(position === "below"
          ? { bottom: "auto", top: "60%" }
          : { top: "auto", bottom: "60%" }),
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Step indicator */}
      <div className="mb-3 flex items-center gap-1.5">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div
            key={i}
            className={`h-1 rounded-full transition-all duration-200 ${
              i === step
                ? "w-4 bg-(--brand-primary)"
                : i < step
                  ? "w-1.5 bg-(--brand-primary)/50"
                  : "w-1.5 bg-[color:var(--color-border-strong)]"
            }`}
          />
        ))}
      </div>

      <h3 className="text-base font-semibold text-[color:var(--brand-foreground)]">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--brand-muted-foreground)]">{body}</p>

      {/* Navigation */}
      <div className="mt-4 flex items-center justify-between">
        <button
          onClick={onSkip}
          className="text-xs text-[color:var(--brand-muted-foreground)] transition-colors hover:text-[color:var(--brand-foreground)]"
        >
          {t("onboarding.skip")}
        </button>
        <div className="flex items-center gap-2">
          {!isFirst && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onPrev}
              className="text-[color:var(--brand-muted-foreground)]"
            >
              {t("onboarding.prev")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={onNext}
            style={{
              backgroundColor: "var(--brand-primary)",
              color: "var(--brand-primary-fg)",
            }}
          >
            {isLast ? t("onboarding.finish") : t("onboarding.next")}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
