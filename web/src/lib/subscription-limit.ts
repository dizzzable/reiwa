/**
 * Multi-subscription capacity helpers for the cabinet SPA.
 *
 * The effective cap is computed server-side:
 *   max(user.maxSubscriptions, multiSubscriptionSettings.defaultMaxSubscriptions)
 * when multi-sub is enabled — otherwise just the per-user column. The BFF
 * flattens that into ActionPolicy.maxSubscriptions / limitReached.
 */
import { toast } from "sonner";
import type { ActionPolicy } from "@/types/api";

export function isSubscriptionLimitReached(
  policy: ActionPolicy | null | undefined,
): boolean {
  if (!policy) return false;
  if (policy.limitReached === true) return true;
  const current = policy.activeSubscriptionCount;
  const max = policy.maxSubscriptions;
  if (
    typeof current === "number" &&
    typeof max === "number" &&
    Number.isFinite(current) &&
    Number.isFinite(max) &&
    max >= 1
  ) {
    return current >= max;
  }
  // Fall back: when the server says buy is closed and the user already has
  // at least one subscription, treat as capacity full (covers older payloads).
  if (policy.canBuy === false && (policy.activeSubscriptionCount ?? 0) > 0) {
    return true;
  }
  return false;
}

/**
 * User-facing notice when Buy is pressed at capacity. Uses toast + optional
 * Telegram haptic / alert so it is visible inside the Mini App WebView.
 */
export function notifySubscriptionLimitReached(
  t: (key: string, opts?: Record<string, unknown>) => string,
  policy?: ActionPolicy | null,
): void {
  const current = policy?.activeSubscriptionCount;
  const max = policy?.maxSubscriptions;
  const message =
    typeof current === "number" && typeof max === "number" && max >= 1
      ? t("subscription.limitReachedDetail", { current, max })
      : t("subscription.limitReached");

  toast.warning(message, { duration: 5_000 });
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("warning");
  } catch {
    // non-TMA / missing SDK
  }
  try {
    window.Telegram?.WebApp?.showAlert?.(message);
  } catch {
    // Desktop or older clients may lack showAlert
  }
}

/** Parse checkout / draft errors for the stable limit code. */
export function isSubscriptionLimitError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  if (!response) return false;
  const data = response.data;
  if (data !== null && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (code === "SUBSCRIPTION_LIMIT_REACHED") return true;
    const nested = (data as { message?: unknown }).message;
    if (
      nested !== null &&
      typeof nested === "object" &&
      (nested as { code?: unknown }).code === "SUBSCRIPTION_LIMIT_REACHED"
    ) {
      return true;
    }
    if (
      typeof nested === "string" &&
      /subscription.?limit|maximum number of active subscriptions/i.test(nested)
    ) {
      return true;
    }
  }
  return false;
}
