/**
 * MyAddOnsPage
 * ────────────
 * User-facing "My add-ons" history — durable add-on entitlements across the
 * user's subscriptions with their lifecycle state, value, price and dates.
 * Read-only; naturally empty until the entitlement ledger is populated.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Gauge, Smartphone, PackagePlus } from "lucide-react";
import { motion } from "motion/react";

import { BackButton } from "@/components/ui/back-button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getAddOnEntitlements } from "@/lib/api-client";
import type { UserAddOnEntitlement } from "@/types/api";
import { formatDateTime } from "@/lib/utils";

const STATE_STYLES: Record<string, string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  PENDING_ACTIVATION: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  EXPIRING: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  EXPIRED: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  REVERSED: "bg-red-500/10 text-red-400 border-red-500/20",
  REMEDIATION_REQUIRED: "bg-red-500/10 text-red-400 border-red-500/20",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  RUB: "₽",
  USDT: "$",
  TON: "TON",
  XTR: "⭐",
};

function formatPrice(amount: string, currency: string): string {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n.toFixed(2) : amount;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol !== undefined ? `${symbol}${value}` : `${value} ${currency}`;
}

export default function MyAddOnsPage() {
  const { t } = useTranslation();

  const { data, isLoading } = useQuery({
    queryKey: ["add-on-entitlements"],
    queryFn: ({ signal }) => getAddOnEntitlements({ signal }),
    staleTime: 30_000,
  });
  const entitlements = data?.entitlements ?? [];

  return (
    <div className="min-h-full pb-6">
      <div className="flex items-center gap-3 px-5 pb-4 pt-6">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("addonsHistory.title")}</h1>
      </div>

      <div className="mx-5">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-2xl" />
            ))}
          </div>
        ) : entitlements.length === 0 ? (
          <div className="theme-surface rounded-2xl border p-8 text-center">
            <PackagePlus className="theme-subtle mx-auto h-8 w-8" />
            <p className="theme-muted mt-2 text-sm">{t("addonsHistory.empty")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {entitlements.map((ent, i) => (
              <EntitlementRow key={ent.id} entitlement={ent} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EntitlementRow({ entitlement, index }: { entitlement: UserAddOnEntitlement; index: number }) {
  const { t } = useTranslation();
  const Icon = entitlement.type === "EXTRA_TRAFFIC" ? Gauge : Smartphone;
  const valueLabel =
    entitlement.type === "EXTRA_TRAFFIC"
      ? t("addons.extraTraffic", { value: entitlement.valuePerUnit })
      : t("addons.extraDevices", { count: entitlement.valuePerUnit });
  const stateCls = STATE_STYLES[entitlement.state] ?? STATE_STYLES.PENDING_ACTIVATION;
  // All six current lifecycle states are mapped; a future backend state falls
  // back to the raw value rather than rendering a raw i18n key.
  const stateLabel = t(`addonsHistory.state.${entitlement.state}`, entitlement.state);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      className="theme-surface flex items-center gap-3 rounded-2xl border p-3.5"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-(--brand-primary)/10 text-(--brand-primary)">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="theme-title truncate text-sm font-medium">{entitlement.receiptName}</p>
          <Badge variant="outline" className={`shrink-0 text-[10px] ${stateCls}`}>
            {stateLabel}
          </Badge>
        </div>
        <p className="theme-muted mt-0.5 text-xs">{valueLabel}</p>
        <div className="mt-0.5 flex items-center justify-between">
          <p className="theme-subtle text-xs">{formatDateTime(entitlement.purchasedAt)}</p>
          <p className="theme-title text-xs font-medium">
            {formatPrice(entitlement.totalAmount, entitlement.currency)}
          </p>
        </div>
        {entitlement.expiresAt && (
          <p className="theme-subtle mt-0.5 text-[11px]">
            {t("addonsHistory.expires", { date: formatDateTime(entitlement.expiresAt) })}
          </p>
        )}
      </div>
    </motion.div>
  );
}
