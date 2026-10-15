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
 * The one sentence every screen says at capacity. A cap of one reads as "while
 * you have your current one", a larger cap as "all slots are taken". It says
 * "have", not "is active": the panel counts every subscription that is not
 * deleted, an expired one included.
 */
export function subscriptionLimitMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  policy?: ActionPolicy | null,
): string {
  const current = policy?.activeSubscriptionCount;
  const max = policy?.maxSubscriptions;
  if (typeof current !== "number" || typeof max !== "number" || max < 1) {
    return t("subscription.limitReached");
  }
  return t(max === 1 ? "subscription.limitReachedOne" : "subscription.limitReachedDetail", { current, max });
}

/**
 * User-facing notice when an action is REFUSED at capacity — a Buy press, or a
 * navigation the app is about to undo. Never a page-load announcement: this
 * fires a toast, a haptic and (by default) a blocking native dialog, which is
 * feedback for something the user just did, not a way to state a fact a screen
 * can state itself.
 *
 * `nativeAlert: false` drops the modal and keeps the toast. Use it when the
 * user stays where they are and the screen already carries the explanation —
 * a modal there is the third telling of one sentence. Keep the default when the
 * app navigates away underneath them: a toast can be missed during a route
 * change, and the modal is what makes the reason survive it.
 */
export function notifySubscriptionLimitReached(
  t: (key: string, opts?: Record<string, unknown>) => string,
  policy?: ActionPolicy | null,
  options?: { readonly nativeAlert?: boolean },
): void {
  const message = subscriptionLimitMessage(t, policy);

  toast.warning(message, { duration: 5_000 });
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("warning");
  } catch {
    // non-TMA / missing SDK
  }
  if (options?.nativeAlert === false) return;
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
