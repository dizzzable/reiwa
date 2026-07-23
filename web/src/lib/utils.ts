import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export { brandAuroraStops } from "./brand-colors";

/**
 * shadcn/ui-canonical class merger.
 * Combines `clsx` (conditional className composition) with `tailwind-merge`
 * (deduplication of conflicting Tailwind utilities — e.g. `p-2 p-4` → `p-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an ISO date string as a compact numeric date: `DD.MM.YY` (e.g. `15.05.26`).
 * Used on the subscription card where space is limited.
 */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

/**
 * Formats an ISO date-time string as a localised short date + time
 * (e.g. "23 окт, 14:30").
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(getActiveLocale(), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Returns the integer number of full days between now and `value`.
 * Negative when the date has already passed, zero on the exact day.
 */
export function getDaysLeft(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const target = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(target.getTime())) return 0;
  const now = Date.now();
  return Math.ceil((target.getTime() - now) / (24 * 60 * 60 * 1000));
}

function getActiveLocale(): string {
  const htmlLang = document.documentElement.lang;
  if (htmlLang && htmlLang.length > 0) return htmlLang;
  return "ru";
}

/**
 * Opens an external URL the right way for the current runtime.
 *
 * Inside the Telegram Mini App the standard `window.open` is unreliable
 * (sandboxed webview), so we use the Telegram WebApp bridge:
 *   - `tg://` / `https://t.me/...` links → `openTelegramLink`
 *   - everything else (subscription deep-links, `http(s)`) → `openLink`
 * Outside Telegram we fall back to a normal new-tab `window.open`.
 *
 * Used by the "Connect" action so tapping it deep-links into the user's VPN
 * client / subscription page instead of merely copying the URL.
 */
export function openExternalUrl(url: string): void {
  if (!url) return;
  const tg = window.Telegram?.WebApp;
  if (tg) {
    if (/^(tg:|https?:\/\/t\.me\/)/i.test(url) && typeof tg.openTelegramLink === "function") {
      tg.openTelegramLink(url);
    } else {
      tg.openLink(url);
    }
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
