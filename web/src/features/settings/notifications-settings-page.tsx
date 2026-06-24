/**
 * NotificationsSettingsPage
 * ─────────────────────────
 * Browser web-push opt-in + subscription expiry toggles. Reached from the
 * Notifications hub.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { getPushPublicKey } from "@/lib/api-client";

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

        <div className="space-y-3">
          <p className="text-sm font-medium text-zinc-300">{t("notifications.beforeExpiry")}</p>
          <div className="rounded-2xl border border-white/6 bg-white/2 p-4 space-y-4">
            <NotifToggle label={t("notifications.days3")} defaultChecked />
            <Separator className="bg-white/6" />
            <NotifToggle label={t("notifications.days2")} defaultChecked={false} />
            <Separator className="bg-white/6" />
            <NotifToggle label={t("notifications.days1")} defaultChecked />
            <Separator className="bg-white/6" />
            <NotifToggle label={t("notifications.dayOf")} defaultChecked />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium text-zinc-300">{t("notifications.afterExpiry")}</p>
          <div className="rounded-2xl border border-white/6 bg-white/2 p-4 space-y-4">
            <NotifToggle label={t("notifications.after1")} defaultChecked />
            <Separator className="bg-white/6" />
            <NotifToggle label={t("notifications.after2")} defaultChecked={false} />
            <Separator className="bg-white/6" />
            <NotifToggle label={t("notifications.after3")} defaultChecked={false} />
          </div>
        </div>

        <p className="text-xs text-zinc-500">{t("notifications.hint")}</p>
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
        <p className="text-sm font-medium text-zinc-300">{t("notifications.pushSection")}</p>
        <div className="h-24 animate-pulse rounded-2xl bg-zinc-800/50" />
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
  const isPermissionDenied = support === "permission-denied";
  const interactiveDisabled = isIOS || isPermissionDenied || busy;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-zinc-300">{t("notifications.pushSection")}</p>
      <div className="rounded-2xl border border-white/6 bg-white/2 p-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
            <Bell className="h-5 w-5" />
          </div>
          <div className="flex-1 space-y-2">
            <p className="text-sm text-zinc-300">{t("notifications.pushDescription")}</p>
            <p className="text-xs text-(--brand-primary)/90">{t("notifications.pushBroadcastsHint")}</p>
            <div className="flex items-center justify-between">
              <Label className="text-sm text-zinc-200 cursor-pointer">
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
              <p className="text-amber-200/70">{t("notifications.pushIosInstallHow")}</p>
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

function NotifToggle({ label, defaultChecked }: { label: string; defaultChecked: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-zinc-300 cursor-pointer">{label}</Label>
      <Switch defaultChecked={defaultChecked} />
    </div>
  );
}
