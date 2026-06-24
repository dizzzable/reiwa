/**
 * TransactionsPage
 * ────────────────
 * Payment history — shows all user transactions with date, amount, gateway,
 * and status badge.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CreditCard } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { motion } from "motion/react";

import { getTransactions } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/utils";

export default function TransactionsPage() {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["transactions"],
    queryFn: () => getTransactions(1, 50),
    staleTime: 30_000,
  });

  const transactions = (data as any)?.transactions ?? [];

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("settings.transactions")}</h1>
      </div>

      <div className="mx-5">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <div className="rounded-2xl border border-white/6 bg-white/2 p-8 text-center">
            <CreditCard className="mx-auto h-8 w-8 text-zinc-600" />
            <p className="mt-2 text-sm text-zinc-400">{t("activity.noTransactions")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.map((tx: any, i: number) => (
              <motion.div
                key={tx.id ?? tx.paymentId ?? i}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-3.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10">
                  <CreditCard className="h-4 w-4 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-zinc-200 truncate">
                      {tx.plan?.name ?? tx.gatewayType ?? "Payment"}
                    </p>
                    <StatusBadge status={tx.status} />
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-xs text-zinc-500">
                      {formatDateTime(tx.createdAt)}
                    </p>
                    <p className="text-xs font-medium text-zinc-300">
                      {tx.pricing?.finalPrice ?? tx.amount ?? "—"} {tx.pricing?.currency ?? tx.currency ?? ""}
                    </p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    COMPLETED: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    PENDING: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    FAILED: "bg-red-500/10 text-red-400 border-red-500/20",
    CANCELED: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };
  const cls = colorMap[status] ?? colorMap.PENDING;
  return (
    <Badge variant="outline" className={`text-[10px] ${cls}`}>
      {status}
    </Badge>
  );
}
