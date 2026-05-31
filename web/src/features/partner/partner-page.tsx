/**
 * PartnerPage
 * ───────────
 * User-facing partner program page. Shown when `partner.isActive === true`.
 *
 * Layout:
 *   1. Invite link hero (same component as referrals).
 *   2. Four stat cards: Level | Referrals | Balance | Info.
 *   3. Bottom sheets for details.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Trophy, Users, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getPartnerInfo, getPartnerEarnings, getPartnerWithdrawals } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { useBranding } from "@/lib/branding-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import { InviteLinkHero } from "../referrals/components/invite-link-hero";
import { StatCard } from "../referrals/components/stat-card";
import { PartnerReferralsList } from "./components/partner-referrals-list";

type ActiveSheet = "level" | "referrals" | "balance" | "info" | null;

export default function PartnerPage() {
  const { t } = useTranslation();
  const { session } = useSession();
  const { branding } = useBranding();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);

  const { data: partnerInfo, isLoading } = useQuery({
    queryKey: ["partner", "info"],
    queryFn: getPartnerInfo,
    staleTime: 30_000,
  });

  const { data: earningsData } = useQuery({
    queryKey: ["partner", "earnings"],
    queryFn: getPartnerEarnings,
    enabled: activeSheet === "balance",
  });

  const info = partnerInfo as any;
  const balance = info?.balance ?? 0;
  const totalEarned = info?.totalEarned ?? 0;
  const totalWithdrawn = info?.totalWithdrawn ?? 0;

  // Build invite links
  const botUsername = (window as any).__REIWA_BOT_USERNAME__ ?? "RezeisBot";
  const reiwaDomain = (window as any).__REIWA_DOMAIN__ ?? window.location.origin;
  const referralCode = session?.telegramId ?? session?.username ?? "";
  const telegramLink = `https://t.me/${botUsername}?start=${referralCode}`;
  const webLink = `${reiwaDomain}/register?ref=${referralCode}`;

  // Format balance in rubles (stored in kopecks)
  const balanceRub = (balance / 100).toFixed(2);
  const totalEarnedRub = (totalEarned / 100).toFixed(2);

  const earnings = (earningsData as any)?.earnings ?? [];

  if (isLoading) {
    return (
      <div className="space-y-4 px-5 pt-6">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-28 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="px-5 pt-6 pb-4">
        <h1 className="text-lg font-semibold">{t("partner.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("partner.subtitle")}</p>
      </div>

      {/* Invite link hero */}
      <InviteLinkHero telegramLink={telegramLink} webLink={webLink} brandName={branding.brandName} />

      {/* Stat cards — 2x2 grid */}
      <div className="mt-5 grid grid-cols-2 gap-3 px-5">
        <StatCard
          icon={Trophy}
          iconColor="#f59e0b"
          value="L1"
          label={t("partner.level")}
          sublabel={t("partner.levelHint")}
          onClick={() => setActiveSheet("level")}
        />
        <StatCard
          icon={Users}
          iconColor="#8b5cf6"
          value={info?.referralsCount ?? 0}
          label={t("partner.referrals")}
          onClick={() => setActiveSheet("referrals")}
        />
        <StatCard
          icon={Wallet}
          iconColor="#22c55e"
          value={`${balanceRub} ₽`}
          label={t("partner.balance")}
          sublabel={t("partner.earned", { amount: totalEarnedRub })}
          onClick={() => setActiveSheet("balance")}
        />
        <StatCard
          icon={Info}
          iconColor="var(--brand-primary)"
          value=""
          label={t("partner.info")}
          onClick={() => setActiveSheet("info")}
        />
      </div>

      {/* Referred users list */}
      <div className="mx-5 mt-5">
        <PartnerReferralsList />
      </div>

      {/* Level Sheet */}
      <Sheet open={activeSheet === "level"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("partner.level")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="rounded-xl border border-white/6 bg-white/3 p-4 text-center">
              <p className="text-4xl font-bold text-amber-400">L1</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("partner.levelDescription")}</p>
            </div>
            <div className="space-y-2">
              {["L1", "L2", "L3"].map((level, i) => (
                <div key={level} className="flex items-center justify-between rounded-xl border border-white/6 bg-white/2 p-3">
                  <span className="text-sm font-medium">{level}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("partner.levelPercent", { level: i + 1 })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Referrals Sheet */}
      <Sheet open={activeSheet === "referrals"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("partner.referrals")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-3 py-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-white/6 bg-white/3 p-3 text-center">
                <p className="text-xl font-bold">{info?.referralsCount ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">L1</p>
              </div>
              <div className="rounded-xl border border-white/6 bg-white/3 p-3 text-center">
                <p className="text-xl font-bold">{info?.level2Count ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">L2</p>
              </div>
              <div className="rounded-xl border border-white/6 bg-white/3 p-3 text-center">
                <p className="text-xl font-bold">{info?.level3Count ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">L3</p>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Balance Sheet */}
      <Sheet open={activeSheet === "balance"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("partner.balance")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="rounded-xl border border-white/6 bg-white/3 p-4 text-center">
              <p className="text-3xl font-bold text-emerald-400">{balanceRub} ₽</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("partner.totalEarned")}: {totalEarnedRub} ₽
              </p>
            </div>

            {/* Withdraw button */}
            <Button
              className="w-full"
              style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
              disabled={balance <= 0}
            >
              {t("partner.withdraw")}
            </Button>

            {/* Recent earnings */}
            {earnings.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-400">{t("partner.recentEarnings")}</p>
                {earnings.slice(0, 10).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between rounded-lg border border-white/6 bg-white/2 p-2.5">
                    <div>
                      <p className="text-xs text-zinc-300">L{e.level} • {e.percent}%</p>
                      <p className="text-[10px] text-zinc-500">{new Date(e.createdAt).toLocaleDateString()}</p>
                    </div>
                    <p className="text-sm font-medium text-emerald-400">
                      +{(e.earnedAmount / 100).toFixed(2)} ₽
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Info Sheet */}
      <Sheet open={activeSheet === "info"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("partner.info")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-3 py-4">
            <p className="text-sm text-zinc-300">{t("partner.infoDescription")}</p>
            <div className="space-y-2">
              {[1, 2, 3].map((step) => (
                <div key={step} className="flex items-start gap-3">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      backgroundColor: "color-mix(in oklab, var(--brand-primary) 15%, transparent)",
                      color: "var(--brand-primary)",
                    }}
                  >
                    {step}
                  </div>
                  <p className="text-sm text-zinc-300">
                    {t(`partner.step${step}`)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
