/**
 * AddOnsDialog (exported as AddOnsSheet for call-site compatibility)
 * ──────────────────────────────────────────────────────────────────
 * Centered modal for buying extra-traffic / extra-devices top-ups on one of
 * the user's subscriptions.
 *
 * Flow:
 *   1. Pick the target subscription (skipped when the user has only one).
 *   2. List add-ons applicable to that subscription's plan.
 *   3. Pick an add-on → pick a payment gateway → checkout.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Gauge, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";

import {
  getAllSubscriptions,
  getEnabledGateways,
  getPlanAddOns,
  purchaseAddOn,
  type AddOn,
} from "@/lib/api-client";
import type { Subscription } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranding } from "@/lib/branding-provider";
import { customIconId, resolveBuiltInIcon } from "@/features/plans/plan-icons";
import { CustomIconView } from "@/components/ui/custom-icon-view";
import { cn } from "@/lib/utils";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

interface AddOnsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Subscription the dialog opens on; user may switch to another one. */
  subscription: Subscription;
}

export function AddOnsSheet({ open, onOpenChange, subscription }: AddOnsSheetProps) {
  const { t } = useTranslation();
  const { customIcons } = useBranding();

  const [selectedSub, setSelectedSub] = useState<Subscription>(subscription);
  const [selectedAddOn, setSelectedAddOn] = useState<AddOn | null>(null);

  // Re-anchor on the subscription the caller opened with each time the dialog
  // is (re)opened, and clear any in-progress add-on selection.
  useEffect(() => {
    if (open) {
      setSelectedSub(subscription);
      setSelectedAddOn(null);
    }
  }, [open, subscription]);

  const { data: subsData } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    enabled: open,
    staleTime: 60_000,
  });
  const subscriptions = (subsData?.subscriptions ?? []).filter(
    (s) => s.status === "ACTIVE" || s.status === "LIMITED",
  );
  const showPicker = subscriptions.length > 1 && !selectedAddOn;

  const planId = selectedSub.plan?.id ?? null;
  const isUnlimitedTraffic = selectedSub.trafficLimit === null;

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

  const purchaseMutation = useMutation({
    mutationFn: (gatewayType: string) =>
      purchaseAddOn({
        addOnId: selectedAddOn!.id,
        subscriptionId: selectedSub.id,
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

  const visibleAddOns = (addOns ?? []).filter(
    (a) => !(isUnlimitedTraffic && a.type === "EXTRA_TRAFFIC"),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setSelectedAddOn(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {selectedAddOn ? t("addons.selectGateway") : t("addons.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {showPicker && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">{t("addons.selectSubscription")}</p>
              <div className="flex flex-wrap gap-2">
                {subscriptions.map((sub) => (
                  <button
                    key={sub.id}
                    onClick={() => {
                      setSelectedSub(sub);
                      setSelectedAddOn(null);
                    }}
                    className={cn(
                      "rounded-xl border px-3 py-1.5 text-xs font-mono transition-colors",
                      sub.id === selectedSub.id
                        ? "border-(--brand-primary) bg-(--brand-primary)/10 text-white"
                        : "border-white/10 text-zinc-400 hover:text-white",
                    )}
                  >
                    {subscriptionTitle(sub)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!selectedAddOn ? (
            isLoading ? (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-2xl" />
                ))}
              </div>
            ) : visibleAddOns.length === 0 ? (
              <div className="flex min-h-[160px] items-center justify-center">
                <div className="w-full rounded-2xl border border-white/6 bg-white/2 px-6 py-8 text-center">
                  <p className="text-xs text-zinc-500">{t("addons.empty")}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t("addons.description")}</p>
                {visibleAddOns.map((addOn) => {
                  const price = addOn.prices[0];
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
                      <div className="min-w-0 flex-1">
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
      </DialogContent>
    </Dialog>
  );
}
