/**
 * EmptySubscriptionCta
 * ────────────────────
 * Shown when the user has zero subscriptions. Encourages them to purchase
 * their first plan with a prominent CTA button.
 */

import { ShoppingCart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";

interface EmptySubscriptionCtaProps {
  onBuy: () => void;
}

export function EmptySubscriptionCta({ onBuy }: EmptySubscriptionCtaProps) {
  const { t } = useTranslation();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", damping: 20 }}
      className="mx-5 flex flex-col items-center rounded-3xl border border-white/6 bg-white/2 p-8 text-center"
    >
      <div
        className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: "color-mix(in oklab, var(--brand-primary) 15%, transparent)" }}
      >
        <ShoppingCart className="h-7 w-7" style={{ color: "var(--brand-primary)" }} />
      </div>
      <h2 className="text-lg font-semibold text-zinc-100">
        {t("subscription.noSubscription")}
      </h2>
      <p className="mt-1 text-sm text-zinc-500">
        {t("subscription.buyFirst")}
      </p>
      <Button
        onClick={onBuy}
        className="mt-6 w-full"
        size="lg"
        style={{
          backgroundColor: "var(--brand-primary)",
          color: "var(--brand-primary-fg)",
        }}
      >
        <ShoppingCart className="mr-2 h-4 w-4" />
        {t("card.actions.buy")}
      </Button>
    </motion.div>
  );
}
