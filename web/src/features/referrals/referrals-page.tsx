/**
 * ReferralsPage
 * ─────────────
 * User-facing referral program page. Layout:
 *   1. Invite link hero (copy / share / QR).
 *   2. Three stat cards: Invited | Points | Info.
 *   3. Bottom sheets for details (opened on card tap).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Star, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { getReferralSummary, getInviteCapacity } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { useBranding } from "@/lib/branding-provider";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StadiumButton } from "@/components/ui/stadium-button";

import { InviteLinkHero } from "./components/invite-link-hero";
import { StatCard } from "./components/stat-card";

type ActiveSheet = "invited" | "points" | "info" | null;

export default function ReferralsPage() {
  const { t } = useTranslation();
  const { session } = useSession();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);

  const { data: summary, isLoading } = useQuery({
    queryKey: ["referrals", "summary"],
    queryFn: getReferralSummary,
    staleTime: 30_000,
  });

  const { data: capacity } = useQuery({
    queryKey: ["referrals", "invite-capacity"],
    queryFn: getInviteCapacity,
    staleTime: 30_000,
  });

  // Build invite links
  const botUsername = (window as any).__REIWA_BOT_USERNAME__ ?? "RezeisBot";
  const reiwaDomain = (window as any).__REIWA_DOMAIN__ ?? window.location.origin;
  const referralCode = session?.telegramId ?? session?.username ?? "";
  const telegramLink = `https://t.me/${botUsername}?start=${referralCode}`;
  const webLink = `${reiwaDomain}/register?ref=${referralCode}`;

  const totalInvited = (summary as any)?.totalReferrals ?? 0;
  const qualified = (summary as any)?.qualifiedReferrals ?? 0;
  const pointsBalance = (summary as any)?.pointsBalance ?? (summary as any)?.points ?? 0;

  if (isLoading) {
    return (
      <div className="space-y-4 px-5 pt-6">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <div className="grid grid-cols-3 gap-3">
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
        <h1 className="text-lg font-semibold">{t("referrals.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("referrals.subtitle")}</p>
      </div>

      {/* Invite link hero */}
      <InviteLinkHero telegramLink={telegramLink} webLink={webLink} brandName={branding.brandName} />

      {/* Stat cards */}
      <div className="mt-5 grid grid-cols-3 gap-3 px-5">
        <StatCard
          icon={Users}
          iconColor="#8b5cf6"
          value={totalInvited}
          label={t("referrals.invited")}
          sublabel={`${qualified} ${t("referrals.qualified").toLowerCase()}`}
          onClick={() => setActiveSheet("invited")}
        />
        <StatCard
          icon={Star}
          iconColor="#f59e0b"
          value={pointsBalance}
          label={t("referrals.points")}
          onClick={() => setActiveSheet("points")}
        />
        <StatCard
          icon={Info}
          iconColor="var(--brand-primary)"
          value=""
          label={t("referrals.howItWorks")}
          onClick={() => setActiveSheet("info")}
        />
      </div>

      {/* Sheets */}
      <Sheet open={activeSheet === "invited"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("referrals.invited")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/6 bg-white/3 p-3 text-center">
                <p className="text-2xl font-bold">{totalInvited}</p>
                <p className="text-xs text-muted-foreground">{t("referrals.invited")}</p>
              </div>
              <div className="rounded-xl border border-white/6 bg-white/3 p-3 text-center">
                <p className="text-2xl font-bold">{qualified}</p>
                <p className="text-xs text-muted-foreground">{t("referrals.qualified")}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("referrals.qualifiedHint")}
            </p>
            {capacity && capacity.totalSlots !== null && (
              <div className="rounded-xl border border-white/6 bg-white/3 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{t("referrals.inviteSlots")}</p>
                  <p className="text-sm font-semibold">
                    {capacity.usedSlots} / {capacity.totalSlots}
                  </p>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {capacity.remainingSlots !== null && capacity.remainingSlots > 0
                    ? t("referrals.inviteSlotsRemaining", { count: capacity.remainingSlots })
                    : t("referrals.inviteSlotsFull")}
                </p>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={activeSheet === "points"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("referrals.points")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <div className="rounded-xl border border-white/6 bg-white/3 p-4 text-center">
              <p className="text-3xl font-bold">{pointsBalance}</p>
              <p className="text-xs text-muted-foreground">{t("referrals.pointsBalance")}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("referrals.pointsHint")}
            </p>
            <StadiumButton
              fullWidth
              size="lg"
              glow
              icon={<Star className="h-5 w-5" />}
              onClick={() => {
                setActiveSheet(null);
                navigate("/referrals/exchange");
              }}
            >
              {t("referrals.exchangePoints")}
            </StadiumButton>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={activeSheet === "info"} onOpenChange={(open) => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("referrals.howItWorks")}</SheetTitle>
          </SheetHeader>
          <div className="space-y-3 py-4">
            {[1, 2, 3, 4].map((step) => (
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
                  {t(`referrals.step${step}`)}
                </p>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
