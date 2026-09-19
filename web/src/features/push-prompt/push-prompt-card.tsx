/**
 * PushPromptCard — «Напомним о продлении и поможем, если не получится
 * подключиться» with [Включить] and [Не сейчас], on the dashboard, right after
 * a purchase, a paid renewal or a free trial.
 *
 * Inline, never a modal: right after a purchase the dashboard may also be
 * showing the «subscription ready» hint and the onboarding tour, and a card in
 * the page cannot stack on either. It waits while the tour runs or is about to
 * start — the tour provider says which (`isActive`, `autoStartPending`) — and
 * appears once it has closed. Shown once per browser, whatever the
 * answer; the switch in «Настройки» → «Уведомления» → «Настройка уведомлений»
 * stays for anyone who changes their mind.
 *
 * ── The tap ─────────────────────────────────────────────────────────────────
 *
 * A permission request made after an await — a network call, a navigation — is
 * made outside the tap's user activation, and browsers then refuse it or never
 * show it. So everything that needs the network happens BEFORE the card
 * appears: the public VAPID key is fetched, and the current subscription read,
 * and [Включить] hands the key to `subscribeToPushWithKey`, whose first await
 * is `Notification.requestPermission()`.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";

import { getPushPublicKey } from "@/lib/api-client";
import {
  detectPushSupport,
  getCurrentSubscription,
  isAppleMobileDevice,
  subscribeToPushWithKey,
  type PushSubscribeOutcome,
} from "@/lib/push";
import { SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT } from "@/lib/subscription-provisioning-receipt";
import { isTelegramMiniAppSurface } from "@/lib/telegram-launch-params";
import { isStandalonePwa } from "@/hooks/use-install-prompt";
import { useOnboardingContext } from "@/features/onboarding/onboarding-tour-controller";
import { StadiumButton } from "@/components/ui/stadium-button";

import {
  mustWaitForTour,
  pushPromptRefusal,
  type PushPromptRefusal,
} from "./push-prompt-policy";
import {
  clearPushPromptEligibility,
  isPushPromptEligible,
  markPushPromptEligible,
  wasPushPromptShown,
  writePushPromptRecord,
} from "./push-prompt-storage";

/**
 * A service worker that never becomes ready leaves `getCurrentSubscription()`
 * waiting forever — and a tap on [Включить] would wait on the same thing. Past
 * this, the card does not appear.
 */
export const PUSH_PROMPT_SW_READY_TIMEOUT_MS = 5_000;

type PromptResult = "enabled" | "blocked" | "notEnabled" | "failed";

type Phase =
  | { readonly kind: "hidden" }
  | { readonly kind: "waiting"; readonly publicKey: string }
  | { readonly kind: "offer"; readonly publicKey: string }
  | { readonly kind: "working" }
  | { readonly kind: "result"; readonly result: PromptResult }
  | { readonly kind: "closed" };

const RESULT_KEYS: Readonly<Record<PromptResult, string>> = {
  enabled: "pushPrompt.enabled",
  blocked: "pushPrompt.blocked",
  notEnabled: "pushPrompt.notEnabled",
  failed: "pushPrompt.failed",
};

function notificationPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

/** Every synchronous condition, cheapest first; anything that throws while asking is a "no". */
function currentRefusal(): PushPromptRefusal | "error" | null {
  try {
    if (!isPushPromptEligible()) return "not-eligible";
    if (wasPushPromptShown()) return "already-shown";
    return pushPromptRefusal({
      eligible: true,
      alreadyShown: false,
      inTelegramMiniApp: isTelegramMiniAppSurface(),
      support: detectPushSupport(),
      appleMobile: isAppleMobileDevice(),
      standalone: isStandalonePwa(),
      permission: notificationPermission(),
    });
  } catch {
    return "error";
  }
}

/**
 * The last look before the card appears, after waiting out the tour: another
 * tab may have shown it meanwhile, or the permission may have been decided in
 * the browser's own settings.
 */
function stillOffered(): boolean {
  try {
    return !wasPushPromptShown() && notificationPermission() === "default";
  } catch {
    return false;
  }
}

/** The value, or `undefined` when it failed or did not come within `ms`. */
function within<T>(start: () => Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve()
      .then(start)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
  });
}

export function PushPromptCard() {
  const { t } = useTranslation();
  const tour = useOnboardingContext();
  const [phase, setPhase] = useState<Phase>({ kind: "hidden" });
  const [eligibilityTick, setEligibilityTick] = useState(0);
  const busy = useRef(false);

  // A subscription just became ready — a purchase or a free trial. Heard here,
  // on the dashboard, because that is where the handoff completes.
  useEffect(() => {
    const onReady = (): void => {
      markPushPromptEligible();
      setEligibilityTick((tick) => tick + 1);
    };
    window.addEventListener(SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT, onReady);
    return () => window.removeEventListener(SUBSCRIPTION_PROVISIONING_COMPLETED_EVENT, onReady);
  }, []);

  // Everything that needs the network, before anything is shown.
  useEffect(() => {
    if (phase.kind !== "hidden") return;
    if (currentRefusal() !== null) return;
    let cancelled = false;
    void (async () => {
      let publicKey = "";
      try {
        publicKey = (await getPushPublicKey()).publicKey.trim();
      } catch {
        return;
      }
      if (cancelled || publicKey.length === 0) return;
      const existing = await within(() => getCurrentSubscription(), PUSH_PROMPT_SW_READY_TIMEOUT_MS);
      // Subscribed already — or the service worker never answered, and a tap
      // would wait on it too.
      if (cancelled || existing !== null) return;
      if (currentRefusal() !== null) return;
      setPhase({ kind: "waiting", publicKey });
    })();
    return () => {
      cancelled = true;
    };
    // `phase` is read, not followed: only a new eligibility starts this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibilityTick]);

  // Wait out the onboarding tour, then show — and only then count it as shown.
  // No polling: the provider re-renders this card whenever the tour starts,
  // stops, or stops being due.
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    if (mustWaitForTour({ tourActive: tour.isActive, tourPending: tour.autoStartPending })) return;
    if (!stillOffered()) {
      setPhase({ kind: "closed" });
      return;
    }
    writePushPromptRecord("shown");
    clearPushPromptEligibility();
    setPhase({ kind: "offer", publicKey: phase.publicKey });
  }, [phase, tour.isActive, tour.autoStartPending]);

  const finish = (outcome: PushSubscribeOutcome | null): void => {
    busy.current = false;
    if (outcome?.ok === true) {
      writePushPromptRecord("accepted");
      setPhase({ kind: "result", result: "enabled" });
      return;
    }
    if (outcome !== null && outcome.reason === "permission-denied") {
      writePushPromptRecord("denied");
      // `denied` means the browser will not ask again; still `default` means the
      // customer closed its question, and the switch in settings still works.
      setPhase({
        kind: "result",
        result: notificationPermission() === "denied" ? "blocked" : "notEnabled",
      });
      return;
    }
    writePushPromptRecord("failed");
    setPhase({ kind: "result", result: "failed" });
  };

  const enable = (): void => {
    if (phase.kind !== "offer" || busy.current) return;
    busy.current = true;
    const { publicKey } = phase;
    setPhase({ kind: "working" });
    // NOTHING is awaited before this call, and its own first await is the
    // permission request: it has to run inside this tap's user activation.
    let pending: Promise<PushSubscribeOutcome>;
    try {
      pending = subscribeToPushWithKey(publicKey);
    } catch {
      pending = Promise.resolve<PushSubscribeOutcome>({ ok: false, reason: "subscribe-failed" });
    }
    void pending.then(finish, () => finish(null));
  };

  const later = (): void => {
    if (phase.kind !== "offer") return;
    writePushPromptRecord("dismissed");
    setPhase({ kind: "closed" });
  };

  if (phase.kind !== "offer" && phase.kind !== "working" && phase.kind !== "result") return null;

  return (
    <div className="mx-5 mt-4" data-testid="push-prompt">
      <div className="flex items-start gap-3 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--brand-primary)/15 text-(--brand-primary)">
          <Bell className="h-5 w-5" aria-hidden />
        </div>
        {phase.kind === "result" ? (
          <p role="status" className="min-w-0 flex-1 text-sm text-[var(--brand-foreground)]" data-testid="push-prompt-result">
            {t(RESULT_KEYS[phase.result])}
          </p>
        ) : (
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-sm text-[var(--brand-foreground)]">{t("pushPrompt.text")}</p>
            <div className="flex flex-wrap gap-2">
              <StadiumButton
                size="sm"
                loading={phase.kind === "working"}
                onClick={enable}
                data-testid="push-prompt-enable"
              >
                {t("pushPrompt.enable")}
              </StadiumButton>
              <StadiumButton
                size="sm"
                variant="ghost"
                disabled={phase.kind === "working"}
                onClick={later}
                data-testid="push-prompt-later"
              >
                {t("pushPrompt.later")}
              </StadiumButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
