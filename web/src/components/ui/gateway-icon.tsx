/**
 * GatewayIcon
 * ───────────
 * Renders a payment gateway's real SVG icon (shared with the admin panel),
 * falling back to the gateway's currency icon, then an emoji. Keyed by the
 * gateway `type` (+ optional `currency`) so every payment-method picker shows
 * a consistent brand icon instead of a bare emoji.
 */
import { Repeat } from "lucide-react";

// The owner's `icon/svg/sbp.svg` without its baked white square, which read
// as a white tile on the dark theme.
import sbpIconUrl from "@/assets/methods/sbp.svg?url";
import { currencyIconUrl, gatewayEmoji, gatewayIconUrl } from "@/lib/gateway-display";
import { cn } from "@/lib/utils";

/** Gateways whose repeat charges run over SBP: their option shows the SBP mark. */
const SBP_AUTOPAY_GATEWAYS: ReadonlySet<string> = new Set(["PLATEGA", "ROLLYPAY"]);

/**
 * The mark of a gateway's «для автоматического списания» option, so the
 * second row of the same gateway reads as "this one charges again" before its
 * caption is read. An SBP subscription shows the SBP mark beside the
 * gateway's own (the owner's picture: Platega, and SBP next to it); ЮKassa,
 * which may save a card, SBP or a wallet, gets a repeat badge instead.
 */
export function AutopayGatewayMark({ type, currency }: { type: string; currency?: string | null }) {
  if (SBP_AUTOPAY_GATEWAYS.has(type)) {
    return (
      <span className="flex h-7 shrink-0 items-center gap-1">
        <GatewayIcon type={type} currency={currency} className="h-7 w-7" />
        <img src={sbpIconUrl} alt="" aria-hidden className="h-6 w-6 object-contain" />
      </span>
    );
  }
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
