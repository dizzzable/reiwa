/**
 * PartnerReferralsList
 * ────────────────────
 * Glass block listing the users referred under this partner, newest first.
 * Pagination lives INSIDE the block (prev/next), and the rows scroll within
 * a fixed-height area with a hidden scrollbar so the page layout stays calm.
 *
 * Mirrors the referral program's `InvitedUsersList`, but each row shows the
 * accrual level (L1/L2/L3) instead of a "qualified" badge.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { getPartnerReferrals } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 6;

export function PartnerReferralsList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["partner", "referrals", page],
    queryFn: () => getPartnerReferrals(page, PAGE_SIZE),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-(--brand-primary)" />
          <p className="text-sm font-semibold text-white">{t("partner.referralsList")}</p>
        </div>
        {total > 0 && (
          <span className="rounded-full bg-white/6 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
            {total}
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/5">
            <UserPlus className="h-5 w-5 text-zinc-500" />
          </div>
          <p className="text-xs text-zinc-500">{t("partner.referralsEmpty")}</p>
        </div>
      ) : (
        <div
          className="scroll-area max-h-[252px] space-y-2 overflow-y-auto"
          style={{ opacity: isFetching ? 0.6 : 1, transition: "opacity 150ms" }}
        >
          {items.map((u, i) => (
            <motion.div
              key={u.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15, delay: i * 0.02 }}
              className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/2 px-3 py-2.5"
            >
              {/* Avatar bubble with first initial */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--brand-primary)/12 text-xs font-bold text-(--brand-primary)">
                {u.label.replace(/^[@:]+/, "").slice(0, 1).toUpperCase() || "?"}
              </div>
              <p className="min-w-0 flex-1 truncate text-sm text-zinc-200">{u.label}</p>
              <span className="shrink-0 rounded-full bg-white/6 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                L{u.level}
              </span>
            </motion.div>
          ))}
        </div>
      )}

      {/* Pagination (only when more than one page) */}
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/6 bg-white/3 text-zinc-300 transition-colors hover:bg-white/6 disabled:opacity-30 disabled:pointer-events-none"
            aria-label={t("common.back")}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-zinc-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/6 bg-white/3 text-zinc-300 transition-colors hover:bg-white/6 disabled:opacity-30 disabled:pointer-events-none"
            aria-label={t("common.next")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
