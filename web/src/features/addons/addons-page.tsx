/**
 * AddOnsPage — full-screen add-on purchase wizard.
 * ────────────────────────────────────────────────
 * Replaces the old centered modal so buying extra traffic / devices reads like
 * the renewal flow:
 *   1. Pick the target subscription (skipped when the user has only one).
 *   2. Pick an add-on applicable to that subscription's plan.
 *   3. Pick a payment gateway (skipped for free add-ons — applied instantly).
 *   4. Checkout → provider redirect, or instant success for free add-ons.
 */
import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Gauge, Plus, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  getAllSubscriptions,
  getEnabledGateways,
  getSubscriptionAddOns,
  purchaseAddOn,
  type EligibleAddOn,
} from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { GatewayIcon } from "@/components/ui/gateway-icon";
import { gatewayLabel } from "@/lib/gateway-display";
import { SubscriptionSelectCard } from "@/components/subscription/subscription-select-card";
import { StepTransition } from "@/components/ui/step-transition";
import { openExternalUrl } from "@/lib/utils";
import { savePendingCheckout } from "@/lib/pending-checkout";
import { BackButton } from "@/components/ui/back-button";
import { useBranding } from "@/lib/branding-provider";
import { customIconId, isEmojiIcon, resolveBuiltInIcon } from "@/features/plans/plan-icons";
import { CustomIconView } from "@/components/ui/custom-icon-view";
import { EmojiText } from "@/components/ui/emoji-text";
import { useAddOnStore } from "@/stores/addons.store";
import { useAccessMode } from "@/lib/use-access-mode";
import { AccessModeBlockedScreen } from "@/components/access-mode-banner";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

/**
 * Formats a decimal price string in the given currency. Falls back to the
 * currency CODE (not an empty string) for unknown currencies so the amount is
 * never shown without a unit, and guards malformed decimals against `NaN`.
 */
function formatPrice(price: string, currency: string): string {
  const n = Number(price);
  const amount = Number.isFinite(n) ? n.toFixed(2) : price;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol !== undefined ? `${symbol}${amount}` : `${amount} ${currency}`;
}

/** The add-on has a price row in the gateway's currency (paid or free). */
function hasPriceForCurrency(addOn: EligibleAddOn, currency: string): boolean {
  return addOn.prices.some((p) => p.currency === currency);
}

/**
 * A gateway is offerable for this add-on only when (a) it is channel-
 * compatible — Telegram Stars is TMA-only, the backend rejects it on web — and
 * (b) the add-on carries a price in the gateway's currency. This stops the
 * "pick a gateway, then a late backend `no price` / channel error" trap.
 */
function isGatewayOfferable(
  gw: { type: string; currency: string },
  addOn: EligibleAddOn | null,
  isTma: boolean,
): boolean {
  if (gw.type === "TELEGRAM_STARS" && !isTma) return false;
  if (addOn === null) return true;
  return hasPriceForCurrency(addOn, gw.currency);
}

/** All configured prices are zero → the add-on is granted without a checkout. */
function isFree(addOn: EligibleAddOn): boolean {
  return addOn.prices.length > 0 && addOn.prices.every((p) => Number(p.price) === 0);
}

export default function AddOnsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { step, reset, selectedSubscriptionId, selectSubscription } = useAddOnStore();
  const { purchasesBlocked } = useAccessMode();

  useEffect(() => () => reset(), [reset]);

  // Dashboard hands off the chosen subscription via `?subscriptionId=` so the
  // user isn't asked to re-pick it (closes the lost-selection gap). Pre-select
  // once on mount; a foreign/invalid id is rejected server-side (v2 scopes the
  // subscription to its owner) and surfaces on the add-on step's error/retry
  // state, and the selection step still works when the param is absent.
  const preselectId = searchParams.get("subscriptionId");
  useEffect(() => {
    if (preselectId && selectedSubscriptionId === null) {
      selectSubscription(preselectId);
    }
  }, [preselectId, selectedSubscriptionId, selectSubscription]);

  // Add-on purchase is a new money-path flow — blocked under
  // PURCHASE_BLOCKED / RESTRICTED.
  if (purchasesBlocked) {
    return (
      <AccessModeBlockedScreen
        modes={["PURCHASE_BLOCKED", "RESTRICTED"]}
        onBack={() => navigate("/dashboard")}
      />
    );
  }

  return (
    <div className="mx-auto max-w-md pb-24 pt-4">
      <div className="flex items-center gap-3 px-5 pb-4">
        <BackButton fallback="/dashboard" label={t("addons.back")} />
        <div className="flex items-center gap-2">
          <Plus className="h-5 w-5 text-(--brand-primary)" />
          <h1 className="text-lg font-semibold">{t("addons.title")}</h1>
        </div>
      </div>

      <StepTransition stepKey={step}>
        {step === "subscriptions" && <SelectSubscription />}
        {step === "addon" && <SelectAddOn />}
        {step === "gateway" && <SelectGateway />}
        {step === "review" && <ReviewStep />}
        {step === "checkout" && <CheckoutStep />}
      </StepTransition>
    </div>
  );
}

function SelectSubscription() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectSubscription } = useAddOnStore();

  const { data, isLoading } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });

  const active = (data?.subscriptions ?? []).filter(
    (s) => s.status === "ACTIVE" || s.status === "LIMITED",
  );

  useEffect(() => {
    if (!isLoading && active.length === 1 && selectedSubscriptionId === null) {
      selectSubscription(active[0]!.id);
    }
  }, [isLoading, active, selectedSubscriptionId, selectSubscription]);

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <div className="px-5">
        <TipCard tone="info">{t("addons.noneActive")}</TipCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-zinc-400">{t("addons.selectSubtitle")}</p>
      <div className="px-5 space-y-2">
        {active.map((sub, index) => (
          <SubscriptionSelectCard
            key={sub.id}
            subscription={sub}
            selected={sub.id === selectedSubscriptionId}
            onSelect={() => selectSubscription(sub.id)}
            control="radio"
            index={index}
            subtitle={sub.plan?.name ?? undefined}
          />
        ))}
      </div>
    </div>
  );
}

function SelectAddOn() {
  const { t } = useTranslation();
  const { customIcons } = useBranding();
  const { selectedSubscriptionId, selectAddOn, selectGateway, setStep } = useAddOnStore();

  // v2 authoritative eligibility: the backend computes what's offerable against
  // THIS subscription's active-term baseline (finite-limit gating + plan
  // applicability already applied server-side), so the wizard never builds its
  // catalog from a possibly-stale client plan snapshot and can't late-reject at
  // checkout. Keyed by subscriptionId and shared with the dashboard top-up gate.
  const { data: eligibility, isLoading, isError, refetch } = useQuery({
    queryKey: ["add-ons-eligibility", selectedSubscriptionId],
    queryFn: () => getSubscriptionAddOns(selectedSubscriptionId ?? ""),
    enabled: selectedSubscriptionId !== null,
    staleTime: 60_000,
  });
  const { data: gateways = [] } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  // Server already withholds ineligible add-ons — no client-side limit filter.
  const visible = eligibility?.addOns ?? [];

  const isTma = !!window.Telegram?.WebApp?.initData;

  const onPick = (addOn: EligibleAddOn) => {
    // Free add-on: skip gateway selection only when an OFFERABLE gateway
    // carries the zero-priced row (channel-compatible + matching currency).
    // Otherwise fall through to the (filtered) gateway step rather than
    // silently picking a currency-mismatched gateway.
    if (isFree(addOn)) {
      const freeGw = gateways.find(
        (gw) =>
          isGatewayOfferable(gw, addOn, isTma) &&
          addOn.prices.some((p) => p.currency === gw.currency && Number(p.price) === 0),
      );
      if (freeGw) {
        selectAddOn(addOn);
        selectGateway({
          id: freeGw.type,
          label: gatewayLabel(freeGw.type, freeGw.displayName),
          icon: "💳",
          currency: freeGw.currency,
        });
        return;
      }
    }
    selectAddOn(addOn);
  };

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">{t("addons.loadError")}</TipCard>
        <StadiumButton fullWidth onClick={() => void refetch()}>
          {t("addons.retry")}
        </StadiumButton>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="info">{t("addons.empty")}</TipCard>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="px-5 text-sm text-muted-foreground">{t("addons.description")}</p>
      <div className="px-5 space-y-2">
        {visible.map((addOn) => {
          const price = addOn.prices[0];
          const free = isFree(addOn);
          const customId = customIconId(addOn.icon);
          const custom = customId ? customIcons.find((c) => c.id === customId) : undefined;
          const BuiltIn = resolveBuiltInIcon(addOn.icon);
          const TypeFallback = addOn.type === "EXTRA_TRAFFIC" ? Gauge : Smartphone;
          return (
            <button
              key={addOn.id}
              onClick={() => onPick(addOn)}
              className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/3 p-4 text-left transition-colors hover:bg-white/6 active:scale-[0.98]"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 text-(--brand-primary)">
                {isEmojiIcon(addOn.icon) ? (
                  <EmojiText text={addOn.icon} className="text-xl leading-none" />
                ) : custom ? (
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
                    : t("addons.extraDevices", { count: addOn.value })}
                </p>
                {addOn.description && (
                  <p className="mt-0.5 text-xs text-zinc-500/80 line-clamp-2">{addOn.description}</p>
                )}
              </div>
              {price && (
                <span className="shrink-0 text-sm font-semibold text-(--brand-primary)">
                  {free ? t("addons.free") : formatPrice(price.price, price.currency)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="px-5 pt-2">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("subscriptions")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function SelectGateway() {
  const { t } = useTranslation();
  const { selectedAddOn, selectGateway, setStep } = useAddOnStore();

  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  const choose = (gw: { type: string; displayName: string; currency: string }) =>
    selectGateway({
      id: gw.type,
      label: gatewayLabel(gw.type, gw.displayName),
      icon: "💳",
      currency: gw.currency,
    });

  const isTma = !!window.Telegram?.WebApp?.initData;
  // Only offer gateways that are channel-compatible AND carry a price in their
  // currency for the selected add-on — so the user can never pick a gateway
  // that the backend would reject with a late "no price" / channel error.
  const offerable = useMemo(
    () =>
      [...gateways]
        .filter((gw) => isGatewayOfferable(gw, selectedAddOn ?? null, isTma))
        .sort((a, b) => {
          if (isTma) {
            if (a.type === "TELEGRAM_STARS") return -1;
            if (b.type === "TELEGRAM_STARS") return 1;
          }
          return 0;
        }),
    [gateways, isTma, selectedAddOn],
  );

  useEffect(() => {
    if (!isLoading && offerable.length === 1) choose(offerable[0]!);
  }, [isLoading, offerable]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceFor = (currency: string): string | null => {
    const row = selectedAddOn?.prices.find((p) => p.currency === currency);
    return row ? formatPrice(row.price, row.currency) : null;
  };

  if (isLoading) {
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">{t("addons.selectGateway")}</h2>
      {selectedAddOn && (
        <p className="px-5 text-sm text-zinc-400">{selectedAddOn.name}</p>
      )}
      <div className="px-5 space-y-2">
        {offerable.map((gw) => {
          const price = priceFor(gw.currency);
          return (
            <button
              key={gw.type}
              onClick={() => choose(gw)}
              className="w-full glass-card p-4 flex items-center gap-4 hover:border-(--brand-primary)/30 active:scale-[0.98] transition-all"
            >
              <GatewayIcon type={gw.type} currency={gw.currency} className="h-7 w-7" />
              <div className="min-w-0 flex-1 text-left">
                <p className="font-medium text-white">{gatewayLabel(gw.type, gw.displayName)}</p>
                <p className="text-xs text-zinc-500">{gw.currency}</p>
              </div>
              {price && (
                <span className="shrink-0 text-sm font-semibold text-(--brand-primary)">{price}</span>
              )}
            </button>
          );
        })}
        {offerable.length === 0 && (
          <div className="py-8 text-center text-sm text-zinc-500">
            {gateways.length === 0 ? t("purchase.gateway.empty") : t("addons.noCompatibleGateway")}
          </div>
        )}
      </div>
      <div className="px-5">
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("addon")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function ReviewStep() {
  const { t } = useTranslation();
  const { selectedSubscriptionId, selectedAddOn, selectedGateway, confirm, setStep } = useAddOnStore();

  const { data: subsData } = useQuery({
    queryKey: ["subscriptions-all"],
    queryFn: getAllSubscriptions,
    staleTime: 60_000,
  });
  const sub = (subsData?.subscriptions ?? []).find((s) => s.id === selectedSubscriptionId) ?? null;

  useEffect(() => {
    if (!selectedAddOn || !selectedGateway) setStep("addon");
  }, [selectedAddOn, selectedGateway, setStep]);
  if (!selectedAddOn || !selectedGateway) return null;

  const free = isFree(selectedAddOn);
  const priceRow = selectedAddOn.prices.find((p) => p.currency === selectedGateway.currency);
  const priceLabel = free
    ? t("addons.free")
    : priceRow
      ? formatPrice(priceRow.price, priceRow.currency)
      : "—";
  const valueLabel =
    selectedAddOn.type === "EXTRA_TRAFFIC"
      ? t("addons.extraTraffic", { value: selectedAddOn.value })
      : t("addons.extraDevices", { count: selectedAddOn.value });

  return (
    <div className="space-y-4">
      <h2 className="px-5 text-base font-semibold">{t("addons.reviewTitle")}</h2>
      <div className="px-5">
        <div className="glass-card space-y-3 p-4">
          <ReviewRow label={t("addons.selectSubscription")} value={sub?.plan?.name ?? sub?.id ?? "—"} />
          <ReviewRow label={selectedAddOn.name} value={valueLabel} />
          {selectedAddOn.description && (
            <p className="text-xs text-zinc-500">{selectedAddOn.description}</p>
          )}
          <ReviewRow label={t("addons.selectGateway")} value={selectedGateway.label} />
          <div className="h-px bg-white/6" />
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">{t("addons.total")}</span>
            <span className="text-base font-semibold text-(--brand-primary)">{priceLabel}</span>
          </div>
        </div>
      </div>
      <div className="px-5 space-y-2">
        <StadiumButton fullWidth onClick={() => confirm()}>
          {free ? t("addons.confirmFree") : t("addons.confirm")}
        </StadiumButton>
        <StadiumButton fullWidth variant="ghost" onClick={() => setStep("addon")}>
          {t("addons.back")}
        </StadiumButton>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="truncate text-sm text-zinc-400">{label}</span>
      <span className="truncate text-right text-sm text-white">{value}</span>
    </div>
  );
}

function CheckoutStep() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedSubscriptionId, selectedAddOn, selectedGateway, setStep } = useAddOnStore();
  // Stable per checkout attempt (per mount): a double-invoke / network-ambiguous
  // retry reuses the same key so the backend replays the draft instead of
  // minting a second PENDING transaction. A fresh attempt (remount) gets a new
  // key, so legitimately re-buying the same add-on later still works.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const mutation = useMutation({
    mutationFn: () =>
      purchaseAddOn({
        addOnId: selectedAddOn!.id,
        subscriptionId: selectedSubscriptionId!,
        gatewayType: selectedGateway!.id,
        // Pin the revision the user saw: an operator recompose during the wizard
        // is rejected upstream (ADDON_REVISION_CONFLICT) instead of buying stale.
        expectedAddOnRevision: selectedAddOn!.revision,
        idempotencyKey,
      }),
    onSuccess: (result) => {
      // The subscription's eligibility changes after a top-up (a consumed /
      // now-ineligible add-on); drop the cached catalog so the dashboard gate
      // and wizard re-fetch instead of showing a stale offer for up to 60s.
      void queryClient.invalidateQueries({ queryKey: ["add-ons-eligibility"] });
      if (result.checkoutUrl) {
        // Stash the URL so the return page can offer a manual "open payment"
        // button — the auto-open below is blocked on Telegram Desktop (openLink
        // must run inside a user gesture, which the async onSuccess has lost).
        savePendingCheckout(result.paymentId, result.checkoutUrl, {
          returnTo: "/addons",
          label: selectedAddOn?.name,
        });
        openExternalUrl(result.checkoutUrl);
        navigate(`/payment-return?paymentId=${result.paymentId}`, { replace: true });
      } else {
        // Free add-on: applied instantly server-side, no redirect.
        toast.success(t("addons.freeApplied"));
        void queryClient.invalidateQueries({ queryKey: ["subscriptions-all"] });
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
        navigate("/dashboard", { replace: true });
      }
    },
    onError: () => {
      // Keep the user inside the wizard (back on review) so they can retry
      // without losing their subscription / add-on / gateway selection —
      // instead of bouncing to the dashboard and starting over.
      toast.error(t("addons.purchaseError"));
      setStep("review");
    },
  });

  useEffect(() => {
    if (!selectedAddOn || !selectedSubscriptionId || !selectedGateway) {
      navigate("/dashboard", { replace: true });
      return;
    }
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4" role="status" aria-live="polite">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      <p className="text-sm text-zinc-400">{t("addons.creating")}</p>
    </div>
  );
}
