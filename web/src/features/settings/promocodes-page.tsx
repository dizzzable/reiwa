/**
 * PromocodesPage (Settings sub-page)
 * ───────────────────────────────────
 * User can:
 *   1. Activate a promocode (input + button).
 *   2. View activation history (list of past activations with reward info).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Gift, Tag } from "lucide-react";
import { motion } from "motion/react";
import { toast } from "sonner";

import { activatePromocode, getPromoActivations } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/utils";

export default function PromocodesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");

  const { data: activationsData, isLoading } = useQuery({
    queryKey: ["promo", "activations"],
    queryFn: () => getPromoActivations(1, 30),
    staleTime: 30_000,
  });

  const activateMutation = useMutation({
    mutationFn: (promoCode: string) => activatePromocode(promoCode),
    onSuccess: () => {
      toast.success(t("promo.success"));
      setCode("");
      queryClient.invalidateQueries({ queryKey: ["promo"] });
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => {
      toast.error(t("promo.error"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("error");
    },
  });

  const activations = (activationsData as any)?.activations ?? [];

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
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

        {/* Activation history */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-zinc-300">{t("promo.history")}</p>

          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-2xl" />
              ))}
            </div>
          ) : activations.length === 0 ? (
            <div className="rounded-2xl border border-white/6 bg-white/2 p-6 text-center">
              <Gift className="mx-auto h-8 w-8 text-zinc-600" />
              <p className="mt-2 text-xs text-zinc-500">{t("promo.historyEmpty")}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {activations.map((activation: any, i: number) => (
                <motion.div
                  key={activation.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-3.5"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10">
                    <Tag className="h-4 w-4 text-violet-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono font-medium text-zinc-200 truncate">
                        {activation.promocode?.code ?? activation.promocodeCode ?? "—"}
                      </p>
                      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                        {activation.rewardType}
                      </Badge>
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {formatDateTime(activation.createdAt ?? activation.activatedAt)}
                      {activation.rewardValue ? ` • +${activation.rewardValue}` : ""}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
