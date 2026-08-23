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
import { Info, Star, Trophy, Users, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { getPartnerInfo, getPartnerEarnings, getPartnerWithdrawals } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { useBranding } from "@/lib/branding-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import { InviteLinkHero } from "../referrals/components/invite-link-hero";
import { StatCard } from "../referrals/components/stat-card";
import { PartnerReferralsList } from "./components/partner-referrals-list";
import { PartnerAdvertisingSection } from "./components/partner-advertising-section";

type ActiveSheet = "level" | "referrals" | "balance" | "info" | null;

export default function PartnerPage() {
  const { t } = useTranslation();
  const { session } = useSession();
  const { branding, botUsername } = useBranding();
  const navigate = useNavigate();
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

  // Referral points (`User.points`) the partner earned BEFORE the
  // appointment. A DIFFERENT POT from `balance`: points are a dimensionless
  // integer, the balance is minor units of currency. No conversion between
  // them exists, so this value is never added to the balance, never divided
  // by 100 and never printed with a currency symbol — it gets its own row.
  //
  // A partner accrues no new points (the panel stops creating referral
  // rewards for them) but keeps whatever they had, and the Partner tab took
  // the single nav slot that used to lead to the exchange. Hence the row
  // below and its way in. It appears only while there is something left to
  // spend: at zero the counter can never move again, so it is noise.
  //
  // Absent is NOT zero. A partner served by an older panel, or a request
  // that failed, leaves this undefined — and an undefined renders nothing at
  // all rather than a "0" this surface cannot actually vouch for.
  const rawPoints = info?.referralPoints;
  const referralPoints =
    typeof rawPoints === "number" && Number.isFinite(rawPoints) ? rawPoints : null;
  const hasReferralPoints = referralPoints !== null && referralPoints > 0;

  // Build invite links. Bot username comes from the public config
  // (reiwa `BOT_USERNAME`); the web origin is this SPA's own domain.
  const referralCode = session?.id ?? session?.telegramId ?? session?.username ?? "";
  const reiwaDomain = window.location.origin;
  const webLink = `${reiwaDomain}/register?ref=${referralCode}`;
  // `ref_` prefix is required for the bot to attribute the referrer — a bare
  // `?start=<code>` is read as the plain menu entry (see `parseDeeplink`).
  const telegramLink = botUsername
    ? `https://t.me/${botUsername}?start=ref_${referralCode}`
    : webLink;

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

      {/* Referral points carried over from before the partner appointment —
          its own row, in its own unit, and the only remaining entry point to
          the exchange now that the Partner tab has replaced the Referral tab
          in the bottom nav. Rendered only while the balance is above zero. */}
      {hasReferralPoints && (
        <div className="mx-5 mt-5" data-testid="partner-referral-points">
          <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-medium">{t("referrals.points")}</span>
              </div>
              {/* Bare integer. No division, no currency — see the note above. */}
              <span className="text-xl font-bold" data-testid="partner-referral-points-value">
                {referralPoints}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t("partner.pointsHint")}</p>
            <Button
              className="mt-3 w-full"
              style={{ backgroundColor: "var(--brand-primary)", color: "var(--brand-primary-fg)" }}
              data-testid="partner-exchange-points"
              onClick={() => navigate("/referrals/exchange")}
            >
              {t("referrals.exchangePoints")}
            </Button>
          </div>
        </div>
      )}

      {/* Referred users list */}
      <div className="mx-5 mt-5">
        <PartnerReferralsList />
      </div>

      {/* Advertising — partner campaigns + request */}
      <div className="mx-5 mt-5">
        <PartnerAdvertisingSection />
      </div>

      {/* Level Sheet */}
      <Sheet open={activeSheet === "level"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("partner.level")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 text-center">
              <p className="text-4xl font-bold text-amber-400">L1</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("partner.levelDescription")}</p>
            </div>
            <div className="space-y-2">
              {["L1", "L2", "L3"].map((level, i) => (
                <div key={level} className="flex items-center justify-between rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] p-3">
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
              <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-center">
                <p className="text-xl font-bold">{info?.referralsCount ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">L1</p>
              </div>
              <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-center">
                <p className="text-xl font-bold">{info?.level2Count ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">L2</p>
              </div>
              <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-3 text-center">
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
            <div className="rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 text-center">
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
                <p className="text-xs font-medium text-[var(--brand-muted-foreground)]">
                  {t("partner.recentEarnings")}
                </p>
                {earnings.slice(0, 10).map((e: any) => (
                  <div key={e.id} className="flex items-center justify-between rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] p-2.5">
                    <div>
                      <p className="text-xs text-[var(--brand-foreground)]">L{e.level} • {e.percent}%</p>
                      <p className="text-[10px] text-[var(--brand-muted-foreground)]">
                        {new Date(e.createdAt).toLocaleDateString()}
                      </p>
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
            <p className="text-sm text-[var(--brand-muted-foreground)]">
              {t("partner.infoDescription")}
            </p>
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
                  <p className="text-sm text-[var(--brand-muted-foreground)]">
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
