/**
 * AddOnsSheet
 * ───────────
 * Bottom sheet for buying extra-traffic / extra-devices top-ups on an
 * existing subscription. Only meaningful when the user has an active
 * subscription, so the entry point (the "Top up" action) is gated by
 * the caller.
 *
 * Flow:
 *   1. List add-ons applicable to the subscription's plan.
 *   2. User picks an add-on → pick a payment gateway.
 *   3. Create checkout → open the provider URL (TMA openLink / window).
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Gauge, Smartphone, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  getPlanAddOns,
  getEnabledGateways,
  purchaseAddOn,
  type AddOn,
} from "@/lib/api-client";
import type { Subscription } from "@/types/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranding } from "@/lib/branding-provider";
import { customIconId, resolveBuiltInIcon } from "@/features/plans/plan-icons";
import { CustomIconView } from "@/components/ui/custom-icon-view";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

interface AddOnsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: Subscription;
}

export function AddOnsSheet({ open, onOpenChange, subscription }: AddOnsSheetProps) {
  const { t } = useTranslation();
  const { customIcons } = useBranding();
  const planId = subscription.plan?.id ?? null;
  const isUnlimitedTraffic = subscription.trafficLimit === null;

  const { data: addOns, isLoading } = useQuery({
    queryKey: ["add-ons", planId],
    queryFn: () => getPlanAddOns(planId ?? ""),
    enabled: open && planId !== null,
    staleTime: 60_000,
  });

  const { data: gateways = [] } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    enabled: open,
    staleTime: 300_000,
  });

  const [selectedAddOn, setSelectedAddOn] = useState<AddOn | null>(null);

  const purchaseMutation = useMutation({
    mutationFn: (gatewayType: string) =>
      purchaseAddOn({
        addOnId: selectedAddOn!.id,
        subscriptionId: subscription.id,
        gatewayType,
      }),
    onSuccess: (result) => {
      const tg = window.Telegram?.WebApp;
      if (result.checkoutUrl) {
        if (tg) tg.openLink(result.checkoutUrl);
        else window.open(result.checkoutUrl, "_blank");
      }
      onOpenChange(false);
      setSelectedAddOn(null);
    },
    onError: () => toast.error(t("addons.purchaseError")),
  });

  // Hide traffic add-ons for unlimited-traffic subscriptions (the
  // backend would reject them anyway).
  const visibleAddOns = (addOns ?? []).filter(
    (a) => !(isUnlimitedTraffic && a.type === "EXTRA_TRAFFIC"),
  );

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) setSelectedAddOn(null); onOpenChange(o); }}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>
            {selectedAddOn ? t("addons.selectGateway") : t("addons.title")}
          </SheetTitle>
        </SheetHeader>

        <div className="py-4 space-y-3">
          {!selectedAddOn ? (
            isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-2xl" />
                ))}
              </div>
            ) : visibleAddOns.length === 0 ? (
              <div className="flex min-h-[180px] items-center justify-center">
                <div className="w-full rounded-2xl border border-white/6 bg-white/2 px-6 py-8 text-center">
                  <p className="text-xs text-zinc-500">{t("addons.empty")}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t("addons.description")}</p>
                {visibleAddOns.map((addOn) => {
                  const price = addOn.prices[0];
                  // Icon priority: custom uploaded → built-in glyph key →
                  // type-derived default (Gauge for traffic, Smartphone for devices).
                  const customId = customIconId(addOn.icon);
                  const custom = customId ? customIcons.find((c) => c.id === customId) : undefined;
                  const BuiltIn = resolveBuiltInIcon(addOn.icon);
                  const TypeFallback = addOn.type === "EXTRA_TRAFFIC" ? Gauge : Smartphone;
                  return (
                    <button
                      key={addOn.id}
                      onClick={() => setSelectedAddOn(addOn)}
                      className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/3 p-4 text-left transition-colors hover:bg-white/6 active:scale-[0.98]"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-(--brand-primary)">
                        {custom ? (
                          <CustomIconView url={custom.url} color={custom.color} className="h-5 w-5" />
                        ) : BuiltIn ? (
                          <BuiltIn className="h-5 w-5" />
                        ) : (
                          <TypeFallback className="h-5 w-5" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white">{addOn.name}</p>
                        <p className="text-xs text-zinc-500">
                          {addOn.type === "EXTRA_TRAFFIC"
                            ? t("addons.extraTraffic", { value: addOn.value })
                            : t("addons.extraDevices", { value: addOn.value })}
                        </p>
                      </div>
                      {price && (
                        <span className="shrink-0 text-sm font-semibold text-(--brand-primary)">
                          {CURRENCY_SYMBOLS[price.currency] ?? ""}
                          {Number(price.price).toFixed(2)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </>
            )
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{selectedAddOn.name}</p>
              {gateways.length === 0 ? (
                <div className="rounded-2xl border border-white/6 bg-white/2 p-6 text-center">
                  <p className="text-xs text-zinc-500">{t("purchase.noGateways")}</p>
                </div>
              ) : (
                gateways.map((gw) => (
                  <button
                    key={gw.type}
                    onClick={() => purchaseMutation.mutate(gw.type)}
                    disabled={purchaseMutation.isPending}
                    className="flex w-full items-center justify-between rounded-2xl border border-white/6 bg-white/3 p-4 text-left transition-colors hover:bg-white/6 active:scale-[0.98] disabled:opacity-50"
                  >
                    <div>
                      <p className="text-sm font-medium text-white">{gw.displayName}</p>
                      <p className="text-xs text-zinc-500">{gw.currency}</p>
                    </div>
                    {purchaseMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                    )}
                  </button>
                ))
              )}
              <button
                onClick={() => setSelectedAddOn(null)}
                className="w-full rounded-2xl py-2 text-sm text-zinc-400 hover:text-white"
              >
                {t("common.back")}
              </button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
