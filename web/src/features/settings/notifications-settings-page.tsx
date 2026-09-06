/**
 * NotificationsSettingsPage
 * ─────────────────────────
 * Browser web-push opt-in + subscription expiry switches. Reached from the
 * Notifications hub.
 *
 * The expiry switches used to be seven `<Switch defaultChecked>` with no
 * handler, no state and no mutation: no route accepted a preference, no
 * column stored one, and the send decision was operator-global. Two of the
 * seven governed reminders no emitter has ever produced — two and three days
 * AFTER expiry — so even a working switch would have controlled nothing.
 *
 * They are driven by the server now, and `available` decides WHICH appear:
 * the panel ships ahead of this image, so a switch this cabinet knows about
 * but that panel does not honour must not be drawn at all.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Smartphone } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  detectPushSupport,
  getCurrentSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupportStatus,
} from "@/lib/push";
import {
  getPushPublicKey,
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/lib/api-client";
import { isTelegramMiniAppSurface } from "@/lib/telegram-launch-params";

export default function NotificationsSettingsPage() {
  const { t } = useTranslation();

  return (
    <div className="min-h-full pb-6">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings/notifications" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("notifications.settingsTitle")}</h1>
      </div>

      <div className="mx-5 space-y-6">
        <BrowserPushSection />

        <ExpiryNotificationSwitches />

        <p className="text-xs text-[var(--brand-muted-foreground)]">{t("notifications.hint")}</p>
      </div>
    </div>
  );
}

/**
 * Browser web-push opt-in card. Probes capability on mount, shows a
 * contextual hint when push isn't available, and drives subscribe /
 * unsubscribe through `lib/push`.
 */
function BrowserPushSection() {
  const { t } = useTranslation();
  const [support, setSupport] = useState<PushSupportStatus | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pushConfigured, setPushConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { publicKey } = await getPushPublicKey();
        if (cancelled) return;
        setPushConfigured(publicKey.trim().length > 0);
      } catch {
        if (cancelled) return;
        setPushConfigured(false);
      }
      const cap = detectPushSupport();
      if (cancelled) return;
      setSupport(cap);
      if (cap === "supported" || cap === "permission-denied") {
        const current = await getCurrentSubscription();
        if (cancelled) return;
        setIsSubscribed(current !== null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (pushConfigured === false) return null;
  if (support === "unsupported-browser") return null;
  if (support === null || pushConfigured === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-[var(--brand-foreground)]">{t("notifications.pushSection")}</p>
        <div className="theme-skeleton h-24 animate-pulse rounded-2xl" />
      </div>
    );
  }

  const handleToggle = async (checked: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (checked) {
        const result = await subscribeToPush();
        if (result.ok) {
          setIsSubscribed(true);
          toast.success(t("notifications.pushEnabled"));
        } else {
          setSupport(detectPushSupport());
          toast.error(t("notifications.pushEnableFailed"));
        }
      } else {
        await unsubscribeFromPush();
        setIsSubscribed(false);
        toast.success(t("notifications.pushDisabledLocally"));
      }
    } finally {
      setBusy(false);
    }
  };

  const isIOS = support === "unsupported-ios-not-installed";
  // `detectPushSupport()` reaches this verdict from the UA plus display-mode,
  // and both are satisfied inside the Telegram Mini App on iPhone — Telegram
  // for iOS sends Safari's own user agent unchanged. The verdict itself is
  // right there (iOS web push really does require an installed PWA); the
  // remedy printed underneath it was not, because that webview has no Share →
  // Add to Home Screen menu to open. Same defect as the Settings install row,
  // same authoritative signal.
  const inTelegram = isTelegramMiniAppSurface();
  const isPermissionDenied = support === "permission-denied";
  const interactiveDisabled = isIOS || isPermissionDenied || busy;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-[var(--brand-foreground)]">{t("notifications.pushSection")}</p>
      <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
            <Bell className="h-5 w-5" />
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-sm text-[var(--brand-foreground)]">{t("notifications.pushDescription")}</p>
            <p className="text-xs text-(--brand-primary)/90">{t("notifications.pushBroadcastsHint")}</p>
            <div className="flex items-center justify-between">
              <Label className="text-sm text-[var(--brand-foreground)] cursor-pointer">
                {isSubscribed
                  ? t("notifications.pushToggleEnabled")
                  : t("notifications.pushToggleEnable")}
              </Label>
              <Switch
                checked={isSubscribed}
                disabled={interactiveDisabled}
                onCheckedChange={handleToggle}
                aria-label={t("notifications.pushToggleEnable")}
              />
            </div>
          </div>
        </div>

        {isIOS && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <Smartphone className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" aria-hidden />
            <div className="text-xs text-amber-200/90 space-y-0.5">
              <p>{t("notifications.pushIosInstall")}</p>
              <p className="text-amber-200/70">
                {inTelegram
                  ? t("notifications.pushIosInstallHowTelegram")
                  : t("notifications.pushIosInstallHow")}
              </p>
            </div>
          </div>
        )}
        {isPermissionDenied && (
          <p className="rounded-xl bg-(--brand-primary)/10 border border-(--brand-primary)/20 px-3 py-2 text-xs text-(--brand-primary)">
            {t("notifications.pushPermissionDenied")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The switches, keyed by the notification type each one silences.
 *
 * The two "after 2 days" / "after 3 days" rows are gone: no emitter produces
 * those reminders, so those controls governed nothing even in principle.
 */
const EXPIRY_SWITCHES: ReadonlyArray<{
  type: string;
  labelKey: string;
  group: "before" | "after";
}> = [
  { type: "expires_in_3_days", labelKey: "notifications.days3", group: "before" },
  { type: "expires_in_2_days", labelKey: "notifications.days2", group: "before" },
  { type: "expires_in_1_days", labelKey: "notifications.days1", group: "before" },
  { type: "expired", labelKey: "notifications.dayOf", group: "before" },
  { type: "expired_1_day_ago", labelKey: "notifications.after1", group: "after" },
];

function ExpiryNotificationSwitches() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: ({ signal }) => getNotificationPreferences({ signal }),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, boolean>) => updateNotificationPreferences(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(["notification-preferences"], result);
    },
    onError: () => {
      // The switch springs back, because the value it was showing is not the
      // value the server holds. Leaving it moved is how the old screen felt.
      void queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      toast.error(t("notifications.prefsSaveFailed"));
    },
  });

  // Only what the panel says it honours. An empty list — an older panel, or
  // an unreachable one — draws no switches rather than dead ones.
  const available = new Set(data?.available ?? []);
  const rows = EXPIRY_SWITCHES.filter((row) => available.has(row.type));
  if (rows.length === 0) return null;

  const isOn = (type: string): boolean => data?.prefs?.[type] !== false;

  const renderGroup = (title: string, group: typeof rows) =>
    group.length === 0 ? null : (
      <div className="space-y-3">
        <p className="text-sm font-medium text-[var(--brand-foreground)]">{title}</p>
        <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-4 space-y-4">
          {group.map((row, index) => (
            <div key={row.type}>
              {index > 0 && <Separator className="mb-4 bg-[var(--color-border-soft)]" />}
              <NotifToggle
                label={t(row.labelKey)}
                checked={isOn(row.type)}
                disabled={save.isPending}
                onCheckedChange={(next) => save.mutate({ [row.type]: next })}
              />
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <>
      {renderGroup(t("notifications.beforeExpiry"), rows.filter((r) => r.group === "before"))}
      {renderGroup(t("notifications.afterExpiry"), rows.filter((r) => r.group === "after"))}
    </>
  );
}

function NotifToggle({
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-[var(--brand-foreground)] cursor-pointer">{label}</Label>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}

