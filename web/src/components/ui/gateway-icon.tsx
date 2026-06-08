/**
 * GatewayIcon
 * ───────────
 * Renders a payment gateway's real SVG icon (shared with the admin panel),
 * falling back to the gateway's currency icon, then an emoji. Keyed by the
 * gateway `type` (+ optional `currency`) so every payment-method picker shows
 * a consistent brand icon instead of a bare emoji.
 */
import { currencyIconUrl, gatewayEmoji, gatewayIconUrl } from "@/lib/gateway-display";
import { cn } from "@/lib/utils";

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
