/**
 * Dashboard Page — Primary destination (tab "Подписки").
 *
 * Layout (top → bottom):
 *   1. Header with welcome text + quick-action icons (Buy, Promo) top-right.
 *   2. Subscription card carousel (bank-card style, swipeable).
 *   3. Action buttons row (Connect / Upgrade / Renew) — actions on current sub.
 *   4. Connected devices list.
 *
 * When the user has no subscriptions, the card area shows a CTA to purchase.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShoppingCart, TicketPercent } from "lucide-react";

import { getAllSubscriptions, getUserDevices } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { SubscriptionCarousel } from "./components/subscription-carousel";
import { SubscriptionActions } from "./components/subscription-actions";
import { DevicesList } from "./components/devices-list";
import { EmptySubscriptionCta } from "./components/empty-subscription-cta";

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { session } = useSession();

  // Fetch all subscriptions for the carousel
  const { data: allSubsData, isLoading: subsLoading } = useQuery({
    queryKey: ["subscriptions", "all"],
    queryFn: getAllSubscriptions,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  // Devices
  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: getUserDevices,
    staleTime: 30_000,
  });

  const subscriptions = (allSubsData as any)?.subscriptions ?? [];
  const devices = (devicesData as any)?.devices ?? [];
  const hasSubscriptions = subscriptions.length > 0;

  return (
    <div className="min-h-full pb-6">
      {/* Header — welcome + quick-action icons top-right */}
      <div className="flex items-center justify-between px-5 pt-6 pb-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          {t("dashboard.welcome", { name: session?.name ?? session?.username ?? "" })}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate("/plans")}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white hover:bg-white/6 transition-colors"
            aria-label={t("card.actions.buy")}
          >
            <ShoppingCart className="h-4 w-4" />
          </button>
          <button
            onClick={() => navigate("/promo")}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white hover:bg-white/6 transition-colors"
            aria-label={t("card.actions.promo")}
          >
            <TicketPercent className="h-4 w-4" />
          </button>
        </div>
      </div>

      {subsLoading ? (
        <div className="flex h-48 items-center justify-center">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: "var(--brand-primary)", borderTopColor: "transparent" }}
          />
        </div>
      ) : hasSubscriptions ? (
        <>
          {/* Subscription card carousel */}
          <div data-tour="subscription-card">
            <SubscriptionCarousel subscriptions={subscriptions} />
          </div>

          {/* Action buttons — actions on the current subscription */}
          <div data-tour="subscription-actions">
            <SubscriptionActions
              subscription={subscriptions[0]}
              onConnect={() => {
                const url = subscriptions[0]?.url;
                if (url) {
                  navigator.clipboard.writeText(url);
                  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
                }
              }}
              onUpgrade={() => navigate("/plans?upgrade=1")}
              onRenew={() => navigate("/plans?renew=1")}
            />
          </div>

          {/* Devices */}
          <div className="mt-6 px-5" data-tour="devices-list">
            <DevicesList devices={devices} isLoading={devicesLoading} />
          </div>
        </>
      ) : (
        <EmptySubscriptionCta onBuy={() => navigate("/plans")} />
      )}
    </div>
  );
}
