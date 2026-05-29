import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, Check } from "lucide-react";
import { getQuote, createCheckout, getEnabledGateways, activatePromocode } from "@/lib/api-client";
import { StadiumButton } from "@/components/ui/stadium-button";
import { TipCard } from "@/components/ui/tip-card";
import { usePurchaseStore } from "@/stores/purchase.store";
import { PromoInput } from "./components/promo-input";
import type { GatewayOption } from "@/stores/purchase.store";
import type { Plan, PlanDuration } from "@/types/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

function SelectDuration({
  plan,
  onSelect,
}: {
  plan: Plan;
  onSelect: (d: PlanDuration) => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">Выберите срок</h2>
      <div className="px-5 space-y-2">
        {plan.durations.map((dur: PlanDuration) => {
          const usdPrice = dur.prices.find((p) => p.currency === "USD");
          const rubPrice = dur.prices.find((p) => p.currency === "RUB");
          const displayPrice = usdPrice ?? rubPrice ?? dur.prices[0];
          return (
            <button
              key={dur.id}
              onClick={() => onSelect(dur)}
              className="w-full glass-card p-4 flex items-center justify-between hover:border-rose-500/30 active:scale-[0.98] transition-all"
            >
              <div className="text-left">
                <p className="font-medium text-white">{dur.days} дней</p>
                <p className="text-xs text-zinc-500">
                  {dur.days >= 365
                    ? "1 год"
                    : dur.days >= 30
                      ? `${Math.round(dur.days / 30)} мес.`
                      : `${dur.days} дн.`}
                </p>
              </div>
              {displayPrice && (
                <p className="text-rose-400 font-semibold">
                  {CURRENCY_SYMBOLS[displayPrice.currency] ?? ""}
                  {displayPrice.price.toFixed(2)}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const GATEWAY_ICONS: Record<string, string> = {
  YOOKASSA: "💳",
  YOOMONEY: "💳",
  TBANK: "🏦",
  ROBOKASSA: "💳",
  CRYPTOMUS: "₿",
  HELEKET: "💎",
  CRYPTOPAY: "₿",
  STRIPE: "💲",
  TELEGRAM_STARS: "⭐",
  MULENPAY: "💳",
  CLOUDPAYMENTS: "☁️",
  PAL24: "💳",
  WATA: "💳",
  PLATEGA: "💳",
};

function SelectGateway({
  onSelect,
}: {
  onSelect: (gw: GatewayOption) => void;
}) {
  const { data: gateways = [], isLoading } = useQuery({
    queryKey: ["gateways"],
    queryFn: getEnabledGateways,
    staleTime: 300_000,
  });

  // Auto-select if only one gateway is available
  useEffect(() => {
    if (!isLoading && gateways.length === 1) {
      const gw = gateways[0];
      onSelect({
        id: gw.type,
        label: gw.displayName,
        icon: GATEWAY_ICONS[gw.type] ?? "💳",
        currency: gw.currency,
      });
    }
  }, [isLoading, gateways]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sort: in TMA context, put Telegram Stars first
  const isTma = !!window.Telegram?.WebApp?.initData;
  const sortedGateways = [...gateways].sort((a, b) => {
    if (isTma) {
      if (a.type === "TELEGRAM_STARS") return -1;
      if (b.type === "TELEGRAM_STARS") return 1;
    }
    return 0;
  });

  if (isLoading)
    return (
      <div className="px-5 space-y-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-2xl bg-zinc-800/50"
          />
        ))}
      </div>
    );

  return (
    <div className="space-y-3">
      <h2 className="px-5 text-base font-semibold">Способ оплаты</h2>
      <div className="px-5 space-y-2">
        {sortedGateways.map((gw) => (
          <button
            key={gw.type}
            onClick={() =>
              onSelect({
                id: gw.type,
                label: gw.displayName,
                icon: GATEWAY_ICONS[gw.type] ?? "💳",
                currency: gw.currency,
              })
            }
            className="w-full glass-card p-4 flex items-center gap-4 hover:border-rose-500/30 active:scale-[0.98] transition-all"
          >
            <span className="text-2xl">{GATEWAY_ICONS[gw.type] ?? "💳"}</span>
            <div className="text-left">
              <p className="font-medium text-white">{gw.displayName}</p>
              <p className="text-xs text-zinc-500">{gw.currency}</p>
            </div>
          </button>
        ))}
        {gateways.length === 0 && (
          <div className="text-center py-8 text-zinc-500 text-sm">
            Платёжные методы временно недоступны
          </div>
        )}
      </div>
    </div>
  );
}

function QuoteView() {
  const { selectedPlan, selectedDuration, selectedGateway, setQuote, goBack } =
    usePurchaseStore();
  const queryClient = useQueryClient();

  const {
    data: quote,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      "quote",
      selectedPlan?.id,
      selectedDuration?.days,
      selectedGateway?.id,
    ],
    queryFn: () =>
      getQuote(selectedPlan!.id, selectedDuration!.days, selectedGateway!.id),
    enabled: !!(selectedPlan && selectedDuration && selectedGateway),
  });

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="px-5 space-y-3">
        <TipCard tone="danger">
          Не удалось получить стоимость. Попробуйте другой метод оплаты.
        </TipCard>
        <StadiumButton fullWidth variant="secondary" onClick={goBack}>
          ← Назад
        </StadiumButton>
      </div>
    );
  }

  return (
    <div className="px-5 space-y-4">
      <h2 className="text-base font-semibold">Подтвердите оплату</h2>

      <div className="glass-card p-5 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Тариф</span>
          <span className="font-medium">{quote.planName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Срок</span>
          <span className="font-medium">{quote.durationDays} дней</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-zinc-400">Метод</span>
          <span className="font-medium">{selectedGateway?.label}</span>
        </div>
        {quote.discountPercent > 0 && (
          <div className="flex justify-between text-sm text-emerald-400">
            <span>Скидка</span>
            <span>-{quote.discountPercent}%</span>
          </div>
        )}
        <div className="border-t border-white/[0.06] pt-3 flex justify-between">
          <span className="font-semibold">Итого</span>
          <span className="text-lg font-bold text-rose-400">
            {CURRENCY_SYMBOLS[quote.currency] ?? ""}
            {quote.finalPrice.toFixed(2)} {quote.currency}
          </span>
        </div>
      </div>

      {/* Promo code input */}
      <PromoInput
        onPromoApplied={(code) => {
          if (code) {
            // The discount is applied to the user's purchaseDiscount
            // server-side on activation; refetch the quote so the
            // updated price is reflected here before checkout.
            void queryClient.invalidateQueries({ queryKey: ["quote"] });
          }
        }}
        validatePromo={async (code) => {
          // Activate the promo against the user's account. DISCOUNT
          // promos bump `purchaseDiscount`, which the quote reads on
          // the next fetch. Throwing surfaces the inline error state.
          await activatePromocode(code);
        }}
      />

      <StadiumButton
        fullWidth
        size="lg"
        onClick={() => setQuote(quote)}
        glow
        icon={<Check className="h-5 w-5" />}
      >
        Перейти к оплате
      </StadiumButton>
      <StadiumButton fullWidth variant="ghost" onClick={goBack}>
        Изменить
      </StadiumButton>
    </div>
  );
}

function CheckoutStep() {
  const { selectedPlan, selectedDuration, selectedGateway, setCheckoutResult } =
    usePurchaseStore();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () =>
      createCheckout(
        selectedPlan!.id,
        selectedDuration!.days,
        selectedGateway!.id,
      ),
    onSuccess: (result) => {
      setCheckoutResult(result.paymentId, result.paymentUrl);
      // Open payment URL — in TMA context use openLink, otherwise window.open
      const tg = window.Telegram?.WebApp;
      if (tg && result.paymentUrl) {
        tg.openLink(result.paymentUrl);
      } else {
        window.open(result.paymentUrl, "_blank");
      }
      // Navigate to payment return to poll status
      navigate(`/payment-return?paymentId=${result.paymentId}`, {
        replace: true,
      });
    },
    onError: () => toast.error("Не удалось создать платёж. Попробуйте позже."),
  });

  useEffect(() => {
    if (!mutation.isPending && !mutation.isSuccess && !mutation.isError) {
      mutation.mutate();
    }
  }, []);

  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
      <p className="text-sm text-zinc-400">Создаём платёж…</p>
    </div>
  );
}

export default function PurchasePage() {
  const navigate = useNavigate();
  const {
    step,
    selectedPlan,
    selectedDuration,
    selectDuration,
    selectGateway,
    goBack,
    reset,
  } = usePurchaseStore();

  // If no plan selected, go back
  useEffect(() => {
    if (!selectedPlan) navigate("/plans", { replace: true });
  }, [selectedPlan, navigate]);

  if (!selectedPlan) return null;

  return (
    <div className="pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <button
          onClick={() => {
            if (step === "duration") {
              reset();
              navigate("/plans");
            } else goBack();
          }}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800/80 text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <p className="text-xs text-zinc-500 uppercase tracking-wide">
            Покупка
          </p>
          <h1 className="text-lg font-semibold">{selectedPlan.name}</h1>
        </div>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-2 px-5 mb-6">
        {(["duration", "gateway", "quote", "checkout"] as const).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={cn(
                "h-1.5 rounded-full transition-colors",
                step === s || (step === "checkout" && i <= 3)
                  ? "bg-rose-500"
                  : "bg-zinc-800",
              )}
              style={{ width: "48px" }}
            />
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          transition={{ duration: 0.2 }}
        >
          {step === "duration" && (
            <SelectDuration plan={selectedPlan} onSelect={selectDuration} />
          )}
          {step === "gateway" && selectedDuration && (
            <SelectGateway onSelect={selectGateway} />
          )}
          {step === "quote" && <QuoteView />}
          {step === "checkout" && <CheckoutStep />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
