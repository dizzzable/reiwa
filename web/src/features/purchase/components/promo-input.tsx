/**
 * PromoInput
 * ──────────
 * Inline promo code input shown on the quote/confirmation step.
 * When a valid code is entered, the quote refreshes with the discount applied.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Tag, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface PromoInputProps {
  /** Called when a promo code is successfully validated (or cleared). */
  onPromoApplied: (code: string | null) => void;
  /** Validation function — should throw on invalid code. */
  validatePromo: (code: string) => Promise<void>;
}

export function PromoInput({ onPromoApplied, validatePromo }: PromoInputProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (promoCode: string) => validatePromo(promoCode),
    onSuccess: () => {
      setAppliedCode(code.toUpperCase());
      onPromoApplied(code.toUpperCase());
      setError(null);
    },
    onError: () => {
      setError(t("promo.error"));
      onPromoApplied(null);
    },
  });

  function handleApply() {
    const normalized = code.trim().toUpperCase();
    if (normalized.length < 3) return;
    setError(null);
    mutation.mutate(normalized);
  }

  function handleClear() {
    setCode("");
    setAppliedCode(null);
    setError(null);
    onPromoApplied(null);
  }

  if (appliedCode) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
        <Check className="h-4 w-4 text-emerald-400" />
        <span className="flex-1 text-sm font-mono text-emerald-300">{appliedCode}</span>
        <button onClick={handleClear} className="text-zinc-500 hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t("promo.placeholder")}
            className="pl-9 font-mono uppercase text-sm"
            maxLength={64}
            onKeyDown={(e) => e.key === "Enter" && handleApply()}
          />
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleApply}
          disabled={code.length < 3 || mutation.isPending}
          className="shrink-0"
        >
          {mutation.isPending ? "..." : t("promo.activate")}
        </Button>
      </div>
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="text-xs text-red-400"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
