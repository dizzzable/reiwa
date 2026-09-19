/**
 * GatewayIcon
 * ───────────
 * Renders a payment gateway's real SVG icon (shared with the admin panel),
 * falling back to the gateway's currency icon, then an emoji. Keyed by the
 * gateway `type` (+ optional `currency`) so every payment-method picker shows
 * a consistent brand icon instead of a bare emoji.
 */
import { Repeat } from "lucide-react";

import { currencyIconUrl, gatewayEmoji, gatewayIconUrl } from "@/lib/gateway-display";
import { cn } from "@/lib/utils";

/**
 * The mark of a gateway's «для автоматического списания» option: the
 * gateway's own icon with a repeat badge, so the second row of the same
 * gateway reads as "this one charges again" before its caption is read.
 */
export function AutopayGatewayMark({ type, currency }: { type: string; currency?: string | null }) {
  return (
    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center text-2xl">
      <GatewayIcon type={type} currency={currency} className="h-7 w-7" />
      <span
        aria-hidden
        className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-(--brand-primary) text-white ring-2 ring-background"
      >
        <Repeat className="h-2.5 w-2.5" />
      </span>
    </span>
  );
}

export function GatewayIcon({
  type,
  currency,
  className,
}: {
  type: string;
  currency?: string | null;
  className?: string;
}) {
  const url = gatewayIconUrl(type) ?? currencyIconUrl(currency);
  if (url) {
    return <img src={url} alt="" aria-hidden className={cn("object-contain", className)} />;
  }
  return (
    <span aria-hidden className={cn("inline-flex items-center justify-center", className)}>
      {gatewayEmoji(type)}
    </span>
  );
}
