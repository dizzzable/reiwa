/**
 * PromocodesPage (Settings sub-page)
 * ───────────────────────────────────
 * User can:
 *   1. Activate a promocode (input + button).
 *   2. View activation history (shared <PromoHistory /> block — active /
 *      expired / applied states with per-type colors).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BackButton } from "@/components/ui/back-button";
import { toast } from "sonner";

import { activatePromocode } from "@/lib/api-client";
import type { PromoActivationResult } from "@/lib/api-client";
import { promoSuccessKey, promoErrorKey } from "@/features/promo/promo-result";
import { PromoHistory } from "@/features/promo/promo-history";
import { SESSION_QUERY_KEY } from "@/hooks/use-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";

export default function PromocodesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");

  const activateMutation = useMutation({
    mutationFn: (promoCode: string) => activatePromocode(promoCode),
    onSuccess: (data: PromoActivationResult) => {
      switch (data.step) {
        case "ACTIVATED":
          toast.success(t(promoSuccessKey(data.reward)));
          setCode("");
          queryClient.invalidateQueries({ queryKey: ["promo"] });
          queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          // Refresh every subscription view so a granted reward (e.g. +days)
          // updates remaining days in the web cabinet immediately.
          queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
          queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.detail });
          queryClient.invalidateQueries({ queryKey: ["devices"] });
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
          break;
        case "SELECT_SUBSCRIPTION":
        case "CREATE_NEW":
          // These need the full chooser / confirm UI — hand off to the
          // dedicated promo page with the code prefilled.
          navigate(`/promo?code=${encodeURIComponent(code.trim().toUpperCase())}`);
          break;
        case "REJECTED":
        default:
          toast.error(t(promoErrorKey(data.errorCode)));
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
          break;
      }
    },
    onError: () => {
      toast.error(t("promo.error"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
    },
  });

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("promo.title")}</h1>
      </div>

      <div className="mx-5 space-y-6">
        {/* Activate section */}
        <div className="rounded-2xl border border-white/6 bg-white/2 p-4 space-y-3">
          <p className="text-sm text-zinc-300">{t("promo.description")}</p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={t("promo.placeholder")}
              className="flex-1 font-mono uppercase"
              maxLength={64}
            />
            <Button
              onClick={() => activateMutation.mutate(code)}
              disabled={code.length < 3 || activateMutation.isPending}
              style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
            >
              {activateMutation.isPending ? "..." : t("promo.activate")}
            </Button>
          </div>
        </div>

        {/* Activation history (shared block) */}
        <PromoHistory />
      </div>
    </div>
  );
}
