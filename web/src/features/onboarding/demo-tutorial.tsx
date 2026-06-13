/**
 * DemoTutorial
 * ────────────
 * Self-contained onboarding shown to a subscription-less user who declined the
 * trial (web-cabinet-onboarding Property 8). Instead of pointing the spotlight
 * tour at a real subscription card that doesn't exist, it walks the user
 * through a clearly-labeled SAMPLE subscription so they still learn the cabinet.
 *
 * Pure front-end: the sample data never touches the backend and is badged
 * "Example/Пример". Works in both the mobile and desktop shells (it's a
 * centered modal, not a DOM-anchored spotlight). One-shot is enforced by the
 * controller (it calls `markCompleted` on close).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Wifi, ShoppingCart, ArrowUpCircle, Smartphone, X } from "lucide-react";

const STEP_KEYS = [
  "onboarding.step1",
  "onboarding.step2",
  "onboarding.step3",
  "onboarding.step4",
  "onboarding.step5",
] as const;

interface DemoTutorialProps {
  open: boolean;
  onClose: () => void;
}

export function DemoTutorial({ open, onClose }: DemoTutorialProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step >= STEP_KEYS.length - 1;
  const stepKey = STEP_KEYS[step];

  function handleNext() {
    if (isLast) {
      onClose();
      return;
    }
    setStep((s) => s + 1);
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
      >
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", damping: 22 }}
          className="relative w-full max-w-sm rounded-3xl border border-white/10 bg-(--brand-bg-primary) p-5 shadow-2xl"
        >
          <button
            onClick={onClose}
            aria-label={t("onboarding.skip")}
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          <p className="text-xs font-semibold uppercase tracking-wider text-(--brand-primary)">
            {t("onboarding.demo.title")}
          </p>
          <p className="mt-1 text-sm text-zinc-400">{t("onboarding.demo.intro")}</p>

          {/* Sample subscription card — clearly labeled as an example. */}
          <div className="relative mt-4 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-4">
            <span className="absolute right-3 top-3 rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-medium text-violet-300">
              {t("onboarding.demo.badge")}
            </span>
            <p className="text-base font-semibold text-white">{t("onboarding.demo.samplePlan")}</p>
            <p className="mt-0.5 text-xs text-emerald-400">{t("onboarding.demo.sampleStatus")}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-400">
              <div className="rounded-lg bg-white/5 px-2 py-1.5">{t("onboarding.demo.sampleExpiry")}</div>
              <div className="rounded-lg bg-white/5 px-2 py-1.5">{t("onboarding.demo.sampleTraffic")}</div>
            </div>
            <div className="mt-2 flex gap-2">
              <span className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-(--brand-primary)/15 py-1.5 text-[11px] text-(--brand-primary)">
                <Wifi className="h-3 w-3" /> VPN
              </span>
              <span className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/5 py-1.5 text-[11px] text-zinc-300">
                <ShoppingCart className="h-3 w-3" />
              </span>
              <span className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/5 py-1.5 text-[11px] text-zinc-300">
                <ArrowUpCircle className="h-3 w-3" />
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Smartphone className="h-3 w-3" /> {t("onboarding.demo.sampleDevices")}
            </div>
          </div>

          {/* Step caption */}
          <div className="mt-4 min-h-[4.5rem]">
            <h3 className="text-base font-semibold text-white">{t(`${stepKey}.title`)}</h3>
            <p className="mt-1 text-sm text-zinc-400">{t(`${stepKey}.body`)}</p>
          </div>

          {/* Progress dots */}
          <div className="mt-3 flex justify-center gap-1.5">
            {STEP_KEYS.map((k, i) => (
              <span
                key={k}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? "w-5 bg-(--brand-primary)" : "w-1.5 bg-white/15"
                }`}
              />
            ))}
          </div>

          {/* Controls */}
          <div className="mt-5 flex items-center gap-3">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-zinc-300 hover:text-white transition-colors"
              >
                {t("onboarding.prev")}
              </button>
            )}
            <button
              onClick={handleNext}
              className="flex-1 rounded-xl bg-(--brand-primary) py-2.5 text-sm font-semibold text-(--brand-primary-fg) transition-all hover:brightness-110 active:scale-[0.98]"
            >
              {isLast ? t("onboarding.demo.close") : t("onboarding.next")}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
