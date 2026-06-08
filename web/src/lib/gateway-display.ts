/**
 * gateway-display
 * ───────────────
 * The backend gateway listing only carries `type` + `currency` (the
 * PaymentGateway model has no display-name column), so the SPA derives the
 * payment-system name + icon from the gateway type. Icons are the real SVG
 * assets shared with the admin panel (`src/assets/payments` + `currency`),
 * loaded as URLs via Vite glob; an emoji is the last-resort fallback.
 */

const paymentIconModules = import.meta.glob("../assets/payments/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const currencyIconModules = import.meta.glob("../assets/currency/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Build a lookup keyed by lower-cased file basename (no extension). */
function byBasename(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(modules)) {
    const base = path.split("/").pop()?.replace(/\.svg$/i, "").toLowerCase();
    if (base) out[base] = url;
  }
  return out;
}

const PAYMENT_URLS = byBasename(paymentIconModules);
const CURRENCY_URLS = byBasename(currencyIconModules);

/** Gateway type → payment-icon file basename (lower-case, no extension). */
const PAYMENT_ICON_FILE: Record<string, string> = {
  YOOKASSA: "yookassa",
  TELEGRAM_STARS: "telegramstars",
  MULENPAY: "mulenpay",
  CRYPTOMUS: "cryptomus",
  CRYPTOPAY: "cryptopay",
  HELEKET: "heleket",
  PLATEGA: "platega",
  WATA: "wata",
  ANTILOPAY: "antilopapay",
  AURAPAY: "aurapay",
  OVERPAY: "overpay",
  PAYPALYCH: "paypalych",
  RIOPAY: "riopay",
  ROLLYPAY: "rollypay",
  SEVERPAY: "severpay",
  LAVA: "lava",
};

/** Currency code → currency-icon file basename. */
const CURRENCY_ICON_FILE: Record<string, string> = {
  RUB: "rubel",
  XTR: "telegramstar",
  TON: "ton",
  USDT: "usdt",
  USDC: "usdc",
  DAI: "dai",
  BTC: "bitcoin",
  BCH: "bitcoincash",
  ETH: "ethereum",
  LTC: "litecoin",
  XMR: "monero",
  SOL: "solana",
  TRX: "trx",
  BNB: "bnb",
  AVAX: "avalanche",
  MATIC: "polygon",
  DASH: "dash",
};

const GATEWAY_EMOJI: Record<string, string> = {
  TELEGRAM_STARS: "⭐",
  CRYPTOMUS: "₿",
  CRYPTOPAY: "₿",
  HELEKET: "💎",
  TBANK: "🏦",
};

const GATEWAY_LABELS: Record<string, string> = {
  YOOKASSA: "ЮKassa",
  YOOMONEY: "ЮMoney",
  TBANK: "Т-Банк",
  ROBOKASSA: "Robokassa",
  CRYPTOMUS: "Cryptomus",
  HELEKET: "Heleket",
  CRYPTOPAY: "CryptoPay",
  STRIPE: "Stripe",
  TELEGRAM_STARS: "Telegram Stars",
  MULENPAY: "MulenPay",
  CLOUDPAYMENTS: "CloudPayments",
  PAL24: "PayAnyWay",
  WATA: "Wata",
  PLATEGA: "Platega",
  ANTILOPAY: "AntiloPay",
  OVERPAY: "Overpay",
  PAYPALYCH: "PayPalych",
  RIOPAY: "RioPay",
  AURAPAY: "AuraPay",
  ROLLYPAY: "RollyPay",
  SEVERPAY: "SeverPay",
  LAVA: "Lava",
};

/** Real payment-system SVG URL for a gateway type, or `null`. */
export function gatewayIconUrl(type: string): string | null {
  const file = PAYMENT_ICON_FILE[type];
  return file ? (PAYMENT_URLS[file] ?? null) : null;
}

/** Currency SVG URL for a currency code, or `null`. */
export function currencyIconUrl(currency: string | null | undefined): string | null {
  if (!currency) return null;
  const file = CURRENCY_ICON_FILE[currency.toUpperCase()];
  return file ? (CURRENCY_URLS[file] ?? null) : null;
}

/** Emoji fallback for a gateway type when no SVG is available. */
export function gatewayEmoji(type: string): string {
  return GATEWAY_EMOJI[type] ?? "💳";
}

/**
 * Display name for a gateway. Prefers an explicit `displayName`, then a known
 * per-type label, then a prettified version of the raw type.
 */
export function gatewayLabel(type: string, displayName?: string | null): string {
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    return displayName;
  }
  return GATEWAY_LABELS[type] ?? prettifyType(type);
}

function prettifyType(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
