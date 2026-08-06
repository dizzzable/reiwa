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
 *
 * REGENERATION HAS TWO OUTCOMES, NOT ONE. Admin-side the wipe runs after the
 * new link is rotated AND persisted, and is non-fatal, so
 * `{ regenerated: true, devicesCleared: false }` is a successful response
 * meaning "new link, old devices still bound". The confirm dialog promises
 * both; the toast has to say which one the customer actually got.
 */

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Copy, Globe, Info, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { AndroidGlyph, AppleGlyph, WindowsGlyph, MacosGlyph, LinuxGlyph } from "@/components/ui/device-glyphs";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { HwidDevice } from "@/types/api";
import {
  deleteSubscriptionDevice,
  regenerateSubscriptionLink,
} from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadErrorCard } from "@/components/ui/load-error-card";
import { StadiumButton } from "@/components/ui/stadium-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";

interface DevicesListProps {
  devices: HwidDevice[];
  isLoading: boolean;
  /**
   * The device read failed. Renders the "could not load" card INSTEAD of the
   * empty card — a customer must never read a panel outage as "no devices".
   */
  isError?: boolean;
  /** A refetch is in flight; disables the retry button. */
  isRefetching?: boolean;
  /** Retry handler for the failure card (TanStack Query `refetch`). */
  onRetry?: () => void;
  /** The subscription whose devices/link these actions operate on. */
  subscriptionId: string;
  /** Current connect URL for this subscription (used by the copy action). */
  subscriptionUrl?: string | null;
  /** Active subscription limits, shown in the multi-subscription info modal. */
  deviceLimit?: number | null;
  trafficLimit?: number | null;
  /** Prevents actions while a destructive card presentation owns this row. */
  disabled?: boolean;
}

export function DevicesList({
  devices,
  isLoading,
  isError = false,
  isRefetching = false,
  onRetry,
  subscriptionId,
  subscriptionUrl,
  deviceLimit,
  trafficLimit,
  disabled = false,
}: DevicesListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // In-app confirmation dialogs (replace native window.confirm so the
  // warnings match the cabinet's glass UI instead of the browser chrome).
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revokeHwid, setRevokeHwid] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (!disabled) return;
    setRegenerateOpen(false);
    setRevokeHwid(null);
  }, [disabled]);

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
    onSuccess: (result) => {
      // The link + device list both change — refresh subscriptions and devices.
      queryClient.invalidateQueries({ queryKey: ["devices", subscriptionId] });
      queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.all });
      // A rotation reports TWO outcomes, and the confirm dialog promised both:
      // a new link AND the old devices disconnected. Admin-side the wipe is
      // secondary and non-fatal — the link is rotated and stored before it
      // runs — so `regenerated: true, devicesCleared: false` is a successful
      // response in which half of what we promised did not happen. Telling
      // that customer to "reconnect your devices" is wrong twice over: nothing
      // was disconnected, and their slots are still occupied, so a reconnect
      // can run straight into the device limit. Say which outcome they got.
      // Absent (the BFF's `{ regenerated: true }` fallback) is not a reported
      // failure and stays on the success path; only an explicit `false` warns.
      if (result?.devicesCleared === false) {
        toast.warning(t("devices.regeneratedNotCleared"), { duration: 8_000 });
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("warning");
        return;
      }
      toast.success(t("devices.regenerated"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => toast.error(t("devices.error")),
    onSettled: () => setRegenerateOpen(false),
  });

  const handleCopy = async () => {
    if (disabled) return;
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
          <Skeleton key={i} className="h-14 w-full rounded-[var(--radius-item)]" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-semibold text-[color:var(--brand-foreground)]">
          {t("devices.title")}
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setInfoOpen(true)}
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-pill)] text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)]"
            aria-label={t("devices.multiInfoAria")}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleCopy}
            disabled={disabled || !subscriptionUrl}
            className="flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)] disabled:opacity-40"
            aria-label={t("devices.copyLink")}
          >
            <Copy className="h-3 w-3" />
            {t("devices.copyLink")}
          </button>
          <button
            onClick={() => setRegenerateOpen(true)}
            disabled={disabled || regenerateMutation.isPending}
            className="flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)] disabled:opacity-50"
            aria-label={t("devices.regenerate")}
          >
            <RefreshCw
              className={`h-3 w-3 ${regenerateMutation.isPending ? "animate-spin" : ""}`}
            />
            {t("devices.regenerate")}
          </button>
        </div>
      </div>

      {isError ? (
        // Checked BEFORE `devices.length === 0` on purpose: a failed read has
        // no rows either, and falling through to the empty card is exactly the
        // "you have no devices" lie this branch exists to prevent.
        <LoadErrorCard
          title={t("devices.loadFailedTitle")}
          body={t("devices.loadFailedBody")}
          retryLabel={t("common.retry")}
          pending={isRefetching}
          onRetry={() => onRetry?.()}
        />
      ) : devices.length === 0 ? (
        <div className="rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-6 text-center">
          <Smartphone className="mx-auto h-8 w-8 text-[color:var(--brand-muted-foreground)] opacity-60" />
          <p className="mt-2 text-xs text-[color:var(--brand-muted-foreground)]">
            {t("devices.empty")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {devices.map((device, i) => (
            <motion.div
              key={device.hwid}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex items-center gap-3 rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-3"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-item)] bg-[color:var(--color-surface-high)]">
                {platformIcon(device.platform)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium text-[color:var(--brand-foreground)]">
                  {device.deviceModel ?? device.platform ?? "Device"}
                </p>
                {device.lastSeenAt && (
                  <p className="text-[11px] text-[color:var(--brand-muted-foreground)]">
                    {t("devices.lastSeen", {
                      when: new Date(device.lastSeenAt).toLocaleDateString(),
                    })}
                  </p>
                )}
              </div>
              <button
                onClick={() => setRevokeHwid(device.hwid)}
                disabled={disabled || revokeMutation.isPending}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[color:var(--brand-muted-foreground)] opacity-70 transition-colors hover:bg-(--brand-primary)/10 hover:text-(--brand-primary) hover:opacity-100"
                aria-label={t("devices.revoke")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {/* ── Regenerate-link confirmation ── */}
      <Dialog
        open={!disabled && regenerateOpen}
        onOpenChange={setRegenerateOpen}
      >
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
              disabled={disabled}
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
        open={!disabled && revokeHwid !== null}
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
              disabled={disabled}
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
          <div className="mt-1 space-y-2 rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[color:var(--brand-muted-foreground)]">{t("devices.multiInfoDeviceLimit")}</span>
              <span className="font-medium text-[color:var(--brand-foreground)]">
                {deviceLimit && deviceLimit > 0 ? deviceLimit : t("devices.unlimited")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[color:var(--brand-muted-foreground)]">{t("devices.multiInfoTrafficLimit")}</span>
              <span className="font-medium text-[color:var(--brand-foreground)]">
                {trafficLimit && trafficLimit > 0
                  ? t("devices.multiInfoTrafficValue", { value: trafficLimit })
                  : t("devices.unlimited")}
              </span>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {t("devices.multiInfoHint")}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function platformIcon(platform: string | null) {
  if (!platform) return <Smartphone className="h-4 w-4 text-[color:var(--brand-muted-foreground)]" />;
  const p = platform.toLowerCase();
  if (p.includes("android")) return <AndroidGlyph className="h-4 w-4 text-emerald-400" />;
  if (p.includes("ios") || p.includes("iphone") || p.includes("ipad"))
    return <AppleGlyph className="h-4 w-4 text-[color:var(--brand-foreground)]" />;
  if (p.includes("mac") || p.includes("darwin") || p.includes("osx"))
    return <MacosGlyph className="h-4 w-4 text-[color:var(--brand-foreground)]" />;
  if (p.includes("windows") || p.includes("win")) return <WindowsGlyph className="h-4 w-4 text-sky-400" />;
  if (p.includes("linux")) return <LinuxGlyph className="h-4 w-4 text-amber-400" />;
  return <Globe className="h-4 w-4 text-[color:var(--brand-muted-foreground)]" />;
}
