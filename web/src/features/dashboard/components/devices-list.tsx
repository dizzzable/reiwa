/**
 * DevicesList
 * ───────────
 * Compact list of connected devices shown below the subscription card on the
 * dashboard, scoped to the CURRENTLY SELECTED subscription. Each device shows
 * platform icon, name, and last-seen timestamp.
 *
 * Header actions (per subscription):
 *   - Copy link      → copies this subscription's connect URL to the clipboard.
 *   - Regenerate link → rotates the Remnawave subscription URL and wipes all
 *                       devices for THIS subscription only (old links die).
 *
 * Revoke acts on a single device of this subscription.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Apple, Copy, Globe, Info, Monitor, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { HwidDevice } from "@/types/api";
import {
  deleteSubscriptionDevice,
  regenerateSubscriptionLink,
} from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { StadiumButton } from "@/components/ui/stadium-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface DevicesListProps {
  devices: HwidDevice[];
  isLoading: boolean;
  /** The subscription whose devices/link these actions operate on. */
  subscriptionId: string;
  /** Current connect URL for this subscription (used by the copy action). */
  subscriptionUrl?: string | null;
  /** Active subscription limits, shown in the multi-subscription info modal. */
  deviceLimit?: number | null;
  trafficLimit?: number | null;
}

export function DevicesList({
  devices,
  isLoading,
  subscriptionId,
  subscriptionUrl,
  deviceLimit,
  trafficLimit,
}: DevicesListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // In-app confirmation dialogs (replace native window.confirm so the
  // warnings match the cabinet's glass UI instead of the browser chrome).
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revokeHwid, setRevokeHwid] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: (hwid: string) => deleteSubscriptionDevice(subscriptionId, hwid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices", subscriptionId] });
      toast.success(t("devices.revoked"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => toast.error(t("devices.error")),
    onSettled: () => setRevokeHwid(null),
  });

  const regenerateMutation = useMutation({
    mutationFn: () => regenerateSubscriptionLink(subscriptionId),
    onSuccess: () => {
      // The link + device list both change — refresh subscriptions and devices.
      queryClient.invalidateQueries({ queryKey: ["devices", subscriptionId] });
      queryClient.invalidateQueries({ queryKey: ["subscriptions", "all"] });
      toast.success(t("devices.regenerated"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => toast.error(t("devices.error")),
    onSettled: () => setRegenerateOpen(false),
  });

  const handleCopy = async () => {
    if (!subscriptionUrl) {
      toast.error(t("devices.error"));
      return;
    }
    try {
      await navigator.clipboard.writeText(subscriptionUrl);
      toast.success(t("devices.copied"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    } catch {
      toast.error(t("devices.error"));
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-semibold text-zinc-300">
          {t("devices.title")}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setInfoOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-white/5 hover:text-white"
            aria-label={t("devices.multiInfoAria")}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleCopy}
            disabled={!subscriptionUrl}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
            aria-label={t("devices.copyLink")}
          >
            <Copy className="h-3 w-3" />
            {t("devices.copyLink")}
          </button>
          <button
            onClick={() => setRegenerateOpen(true)}
            disabled={regenerateMutation.isPending}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
            aria-label={t("devices.regenerate")}
          >
            <RefreshCw
              className={`h-3 w-3 ${regenerateMutation.isPending ? "animate-spin" : ""}`}
            />
            {t("devices.regenerate")}
          </button>
        </div>
      </div>

      {devices.length === 0 ? (
        <div className="rounded-2xl border border-white/6 bg-white/2 p-6 text-center">
          <Smartphone className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-2 text-xs text-zinc-500">{t("devices.empty")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {devices.map((device, i) => (
            <motion.div
              key={device.hwid}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/60">
                {platformIcon(device.platform)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-200 truncate">
                  {device.deviceModel ?? device.platform ?? "Device"}
                </p>
                {device.lastSeenAt && (
                  <p className="text-[11px] text-zinc-500">
                    {t("devices.lastSeen", {
                      when: new Date(device.lastSeenAt).toLocaleDateString(),
                    })}
                  </p>
                )}
              </div>
              <button
                onClick={() => setRevokeHwid(device.hwid)}
                disabled={revokeMutation.isPending}
                className="shrink-0 flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 hover:text-(--brand-primary) hover:bg-(--brand-primary)/10 transition-colors"
                aria-label={t("devices.revoke")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* ── Regenerate-link confirmation ── */}
      <Dialog open={regenerateOpen} onOpenChange={setRegenerateOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("devices.regenerate")}</DialogTitle>
            <DialogDescription>{t("devices.regenerateConfirm")}</DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-2">
            <StadiumButton
              variant="danger"
              size="lg"
              fullWidth
              loading={regenerateMutation.isPending}
              icon={<RefreshCw className="h-5 w-5" />}
              onClick={() => regenerateMutation.mutate()}
            >
              {t("devices.regenerate")}
            </StadiumButton>
            <StadiumButton
              variant="ghost"
              size="md"
              fullWidth
              onClick={() => setRegenerateOpen(false)}
            >
              {t("common.cancel")}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Revoke-device confirmation ── */}
      <Dialog
        open={revokeHwid !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeHwid(null);
        }}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("devices.revoke")}</DialogTitle>
            <DialogDescription>{t("devices.revokeConfirm")}</DialogDescription>
          </DialogHeader>
          <div className="mt-2 flex flex-col gap-2">
            <StadiumButton
              variant="danger"
              size="lg"
              fullWidth
              loading={revokeMutation.isPending}
              icon={<Trash2 className="h-5 w-5" />}
              onClick={() => {
                if (revokeHwid !== null) revokeMutation.mutate(revokeHwid);
              }}
            >
              {t("devices.revoke")}
            </StadiumButton>
            <StadiumButton
              variant="ghost"
              size="md"
              fullWidth
              onClick={() => setRevokeHwid(null)}
            >
              {t("common.cancel")}
            </StadiumButton>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Multi-subscription info ── */}
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("devices.multiInfoTitle")}</DialogTitle>
            <DialogDescription>{t("devices.multiInfoBody")}</DialogDescription>
          </DialogHeader>
          <div className="mt-1 space-y-2 rounded-2xl border border-white/6 bg-white/2 p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-zinc-400">{t("devices.multiInfoDeviceLimit")}</span>
              <span className="font-medium text-zinc-100">
                {deviceLimit && deviceLimit > 0 ? deviceLimit : t("devices.unlimited")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-zinc-400">{t("devices.multiInfoTrafficLimit")}</span>
              <span className="font-medium text-zinc-100">
                {trafficLimit && trafficLimit > 0
                  ? t("devices.multiInfoTrafficValue", { value: trafficLimit })
                  : t("devices.unlimited")}
              </span>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
            {t("devices.multiInfoHint")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function platformIcon(platform: string | null) {
  if (!platform) return <Smartphone className="h-4 w-4 text-zinc-400" />;
  const p = platform.toLowerCase();
  if (p.includes("android")) return <Smartphone className="h-4 w-4 text-emerald-400" />;
  if (p.includes("ios") || p.includes("iphone") || p.includes("mac"))
    return <Apple className="h-4 w-4 text-zinc-300" />;
  if (p.includes("windows")) return <Monitor className="h-4 w-4 text-blue-400" />;
  return <Globe className="h-4 w-4 text-zinc-400" />;
}
