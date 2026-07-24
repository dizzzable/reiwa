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

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { ShoppingCart, TicketPercent } from "lucide-react";

import { getActionPolicy, getAllSubscriptions, getSubscriptionDevices } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { useBranding } from "@/lib/branding-provider";
import { useAccessMode } from "@/lib/use-access-mode";
import { AccessModeBanner } from "@/components/access-mode-banner";
import {
  isSubscriptionLimitReached,
  notifySubscriptionLimitReached,
} from "@/lib/subscription-limit";
import { openExternalUrl, cn } from "@/lib/utils";
import { ReiwaLogo } from "@/components/ui/reiwa-logo";
import { SubscriptionCarousel } from "./components/subscription-carousel";
import { SubscriptionActions } from "./components/subscription-actions";
import { DevicesList } from "./components/devices-list";
import { NotificationBell } from "./components/notification-bell";
import { QuestsIcon } from "./components/quests-icon";
import { EmptySubscriptionCta } from "./components/empty-subscription-cta";
import { TrialCta } from "./components/trial-cta";
import {
  buildSubscriptionCarouselItems,
  resolveActiveCarouselItemKey,
  selectNewestUnfocusedProvisioningKey,
  subscriptionCarouselItemKey,
} from "./subscription-lifecycle-policy";
import { useSubscriptionProvisioning } from "./use-subscription-provisioning";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import type { Subscription } from "@/types/api";

export default function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { session } = useSession();
  const { branding } = useBranding();
  const { purchasesBlocked, restricted } = useAccessMode();
  const reduceMotion = useReducedMotion();
  const queryClient = useQueryClient();

  // Active-discount glow for the promo shortcut: violet for the permanent
  // personal discount, amber for the one-time next-purchase discount, split
  // when both are set (they don't stack — personal takes priority on price —
  // but both are surfaced so the user sees what's active).
  const hasPersonalDiscount = (session?.personalDiscount ?? 0) > 0;
  const hasPurchaseDiscount = (session?.purchaseDiscount ?? 0) > 0;
  const promoGlowStyle = buildPromoGlowStyle(hasPersonalDiscount, hasPurchaseDiscount);

  // Fetch all subscriptions for the carousel
  const { data: allSubsData, isLoading: subsLoading } = useQuery({
    queryKey: subscriptionQueryKeys.all,
    queryFn: getAllSubscriptions,
    staleTime: 30_000,
  });

  // Capacity for multi-sub Buy gating (effective max folds per-user + global).
  const { data: actionPolicy } = useQuery({
    queryKey: ["action-policy"],
    queryFn: () => getActionPolicy(),
    staleTime: 30_000,
  });

  const subscriptions = allSubsData?.subscriptions ?? [];
  const {
    runtimes: provisioningRuntimes,
    completeHandoff,
    startTrialProvisioning,
  } = useSubscriptionProvisioning();
  const focusedProvisioningPaymentIds = useRef(
    new Set(provisioningRuntimes.map((runtime) => runtime.receipt.paymentId)),
  );
  const carouselItems = useMemo(
    () =>
      buildSubscriptionCarouselItems(
        subscriptions,
        provisioningRuntimes,
      ),
    [provisioningRuntimes, subscriptions],
  );
  const carouselItemKeys = carouselItems.map((item) => item.key);
  const carouselItemKeySignature = carouselItemKeys.join("|");
  const [activeItemKey, setActiveItemKey] = useState<string | null>(() =>
    selectNewestUnfocusedProvisioningKey(
      provisioningRuntimes,
      new Set<string>(),
    ),
  );
  const resolvedActiveItemKey = resolveActiveCarouselItemKey(
    carouselItemKeys,
    activeItemKey,
  );
  const activeItem =
    carouselItems.find((item) => item.key === resolvedActiveItemKey) ?? null;
  const activeSubscription =
    activeItem?.kind === "subscription" ? activeItem.subscription : null;
  const activeSubscriptionId: string | null =
    activeSubscription?.id ?? null;
  const hasCarouselItems = carouselItems.length > 0;

  useEffect(() => {
    if (resolvedActiveItemKey !== activeItemKey) {
      setActiveItemKey(resolvedActiveItemKey);
    }
  }, [
    activeItemKey,
    carouselItemKeySignature,
    resolvedActiveItemKey,
  ]);

  useEffect(() => {
    const focusKey = selectNewestUnfocusedProvisioningKey(
      provisioningRuntimes,
      focusedProvisioningPaymentIds.current,
    );
    for (const runtime of provisioningRuntimes) {
      focusedProvisioningPaymentIds.current.add(runtime.receipt.paymentId);
    }
    if (focusKey !== null) {
      setActiveItemKey(focusKey);
    }
  }, [provisioningRuntimes]);

  const buyLimitReached = isSubscriptionLimitReached(actionPolicy);

  const handleBuy = () => {
    if (purchasesBlocked) return;
    // Hard stop: never open the plan catalog when capacity is full.
    // Server also rejects NEW/ADDITIONAL drafts with SUBSCRIPTION_LIMIT_REACHED.
    if (buyLimitReached) {
      notifySubscriptionLimitReached(t, actionPolicy);
      return;
    }
    navigate("/plans");
  };

  // The device list follows the currently selected subscription card.
  // Devices — scoped to the active subscription so switching cards swaps the
  // device list (each subscription has its own Remnawave profile).
  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ["devices", activeSubscriptionId],
    queryFn: () => getSubscriptionDevices(activeSubscriptionId as string),
    enabled: activeSubscriptionId !== null,
    staleTime: 30_000,
  });

  const devices = devicesData?.devices ?? [];
  const firstDeviceById: Record<string, string | null> =
    activeSubscriptionId !== null
      ? {
          [activeSubscriptionId]:
            devices.length > 0
              ? (devices[0]?.deviceModel ?? devices[0]?.platform ?? null)
              : null,
        }
      : {};

  const handleProvisioningComplete = useCallback(
    (paymentId: string, subscription: Subscription) => {
      completeHandoff(paymentId);
      setActiveItemKey(subscriptionCarouselItemKey(subscription.id));
      void queryClient.invalidateQueries({ queryKey: ["action-policy"] });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    [completeHandoff, queryClient],
  );

  const handleTrialActivated = useCallback(
    (
      subscriptionId: string | undefined,
      knownSubscriptionIds: readonly string[],
    ) => {
      startTrialProvisioning({
        subscriptionId,
        knownSubscriptionIds,
        slotIndex: subscriptions.length,
      });
    },
    [startTrialProvisioning, subscriptions.length],
  );

  return (
    <div className="min-h-full pb-8">
      {/* Header — brand + welcome on the left, quick-action icons on the right */}
      <div className="flex items-center justify-between px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {branding.logoUrl ? (
            <img
              src={branding.logoUrl}
              alt={branding.brandName}
              className="h-8 w-8 shrink-0 rounded-lg object-contain"
            />
          ) : (
            <ReiwaLogo className="h-8 w-8 shrink-0 text-(--brand-primary)" title={branding.brandName} />
          )}
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-white">{branding.brandName}</p>
            <p className="truncate text-[11px] tracking-wide text-muted-foreground">
              {t("dashboard.welcome", {
                name:
                  session?.name ||
                  session?.username ||
                  session?.webAccount?.login ||
                  "",
              })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="relative shrink-0">
            {!purchasesBlocked && !buyLimitReached && !reduceMotion && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full"
                style={{ border: "1.5px solid var(--brand-primary)" }}
                initial={{ opacity: 0.5, scale: 1 }}
                animate={{ opacity: 0, scale: 1.75 }}
                transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            <button
              onClick={handleBuy}
              disabled={purchasesBlocked}
              className={cn(
                "relative flex h-9 w-9 items-center justify-center rounded-full border transition-all disabled:opacity-40 disabled:pointer-events-none",
                purchasesBlocked || buyLimitReached
                  ? "border-white/6 bg-white/3 text-zinc-400"
                  : "border-(--brand-primary)/40 bg-(--brand-primary)/15 text-(--brand-primary) hover:bg-(--brand-primary)/25",
              )}
              aria-label={t("card.actions.buy")}
              title={
                buyLimitReached
                  ? typeof actionPolicy?.activeSubscriptionCount === "number" &&
                    typeof actionPolicy?.maxSubscriptions === "number"
                    ? t("subscription.limitReachedDetail", {
                        current: actionPolicy.activeSubscriptionCount,
                        max: actionPolicy.maxSubscriptions,
                      })
                    : t("subscription.limitReached")
                  : undefined
              }
            >
              <ShoppingCart className="h-4 w-4" />
            </button>
          </div>
          <button
            onClick={() => navigate("/promo")}
            style={promoGlowStyle}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white hover:bg-white/6 transition-all"
            aria-label={t("card.actions.promo")}
          >
            <TicketPercent className="h-4 w-4" />
          </button>
          <QuestsIcon />
          <NotificationBell />
        </div>
      </div>

      {/* Access-mode notice — surfaces non-PUBLIC modes that affect the cabinet. */}
      <div className="px-5 pb-2 empty:hidden">
        <AccessModeBanner modes={["PURCHASE_BLOCKED", "REG_BLOCKED", "INVITED", "RESTRICTED"]} />
      </div>

      {subsLoading && !hasCarouselItems ? (
        <div className="flex h-48 items-center justify-center">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
            style={{ borderColor: "var(--brand-primary)", borderTopColor: "transparent" }}
          />
        </div>
      ) : hasCarouselItems ? (
        <>
          {/* Subscription card carousel */}
          <div data-tour="subscription-card">
            <SubscriptionCarousel
              items={carouselItems}
              firstDeviceById={firstDeviceById}
              activeItemKey={resolvedActiveItemKey}
              onActiveItemKeyChange={setActiveItemKey}
              onProvisioningComplete={handleProvisioningComplete}
            />
          </div>

          {/* Action buttons — actions on the current subscription */}
          <div data-tour="subscription-actions">
            <SubscriptionActions
              subscription={activeSubscription}
              purchasesBlocked={purchasesBlocked}
              restricted={restricted}
              onConnect={() => {
                const url = activeSubscription?.url;
                if (url) {
                  openExternalUrl(url);
                  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
                }
              }}
              onUpgrade={() => navigate("/upgrade")}
              onRenew={() => navigate("/renew")}
            />
          </div>

          {/* Devices — scoped to the selected subscription */}
          {activeSubscriptionId && (
            <div className="mt-6 px-5" data-tour="devices-list">
              <DevicesList
                devices={devices}
                isLoading={devicesLoading}
                subscriptionId={activeSubscriptionId}
                subscriptionUrl={activeSubscription?.url ?? null}
                deviceLimit={activeSubscription?.deviceLimit ?? null}
                trafficLimit={activeSubscription?.trafficLimit ?? null}
              />
            </div>
          )}
        </>
      ) : (
        <>
          <TrialCta
            knownSubscriptionIds={subscriptions.map((subscription) => subscription.id)}
            onActivated={handleTrialActivated}
          />
          <EmptySubscriptionCta onBuy={handleBuy} />
        </>
      )}
    </div>
  );
}

/**
 * Glow style for the promo shortcut based on the user's active discounts.
 * Violet = permanent personal discount, amber = one-time next-purchase
 * discount, split (left violet / right amber) when both are active. Returns
 * `undefined` when no discount is active so the icon keeps its neutral look.
 */
function buildPromoGlowStyle(
  hasPersonal: boolean,
  hasPurchase: boolean,
): CSSProperties | undefined {
  const VIOLET = "168, 85, 247";
  const AMBER = "245, 158, 11";
  if (hasPersonal && hasPurchase) {
    return {
      background: `linear-gradient(90deg, rgba(${VIOLET}, 0.22) 0 50%, rgba(${AMBER}, 0.22) 50% 100%)`,
      borderColor: "transparent",
      color: "#ffffff",
      boxShadow: `-6px 0 16px -3px rgba(${VIOLET}, 0.85), 6px 0 16px -3px rgba(${AMBER}, 0.9)`,
    };
  }
  if (hasPersonal) {
    return {
      background: `rgba(${VIOLET}, 0.16)`,
      borderColor: `rgba(${VIOLET}, 0.55)`,
      color: "#d8b4fe",
      boxShadow: `0 0 16px -2px rgba(${VIOLET}, 0.85)`,
    };
  }
  if (hasPurchase) {
    return {
      background: `rgba(${AMBER}, 0.16)`,
      borderColor: `rgba(${AMBER}, 0.6)`,
      color: "#fcd34d",
      boxShadow: `0 0 16px -2px rgba(${AMBER}, 0.9)`,
    };
  }
  return undefined;
}
