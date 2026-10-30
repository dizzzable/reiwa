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
 * A free slot is offered as a row of its own under the devices (the owner,
 * 30.10.2026): «Можно подключить ещё N устройств», quiet on purpose — a dashed
 * circle and muted words, the list's last line, not a call to action. Tapping
 * it shows THIS subscription's link as a QR code, so a second phone, a TV box
 * or a laptop adds it from its VPN app's camera scanner instead of somebody
 * mailing themselves the link. Only for a subscription that runs and has a
 * link, and only while a slot is free (or the subscription has no limit).
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
import { Copy, Globe, Info, Plus, QrCode, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { AndroidGlyph, AppleGlyph, WindowsGlyph, MacosGlyph, LinuxGlyph } from "@/components/ui/device-glyphs";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { HwidDevice } from "@/types/api";
import {
  deleteSubscriptionDevice,
  regenerateSubscriptionLink,
} from "@/lib/api-client";
import { LocalQr } from "@/components/ui/local-qr";
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
import { useOperatorTimeZone } from "@/lib/operator-time-zone";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import { formatDate } from "@/lib/utils";

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
  /**
   * Whether a new device can join this subscription now — it runs. Off, the
   * «можно подключить ещё» row is not offered: a code that adds an expired
   * subscription to a second phone is a second thing that does not work.
   */
  canAddDevice?: boolean;
  /** The plan's name, under the code, so it is clear WHICH subscription it adds. */
  subscriptionName?: string | null;
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
  canAddDevice = false,
  subscriptionName = null,
}: DevicesListProps) {
  const { t } = useTranslation();
  // «Был в сети» on the operator's calendar, as the subscription's dates are.
  const dateZone = useOperatorTimeZone();
  const queryClient = useQueryClient();
  // In-app confirmation dialogs (replace native window.confirm so the
  // warnings match the cabinet's glass UI instead of the browser chrome).
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [revokeHwid, setRevokeHwid] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!disabled) return;
    setRegenerateOpen(false);
    setRevokeHwid(null);
    setAddOpen(false);
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

  // Free slots; `null` — no limit. Shown only after a successful read: a
  // failed one has no rows, and «ещё 3» would be a guess.
  const limited = deviceLimit !== null && deviceLimit !== undefined && deviceLimit > 0;
  const freeSlots = limited ? Math.max(0, deviceLimit - devices.length) : null;
  const offerAdd =
    !isError && !disabled && canAddDevice && Boolean(subscriptionUrl) && (freeSlots === null || freeSlots > 0);

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
      ) : null}

      {isError || devices.length === 0 ? null : (
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
                      when: formatDate(device.lastSeenAt, dateZone),
                    })}
                  </p>
                )}
              </div>
              <button
                onClick={() => setRevokeHwid(device.hwid)}
                disabled={disabled || revokeMutation.isPending}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[color:var(--brand-muted-foreground)] opacity-70 transition-colors hover:bg-(--brand-ink)/10 hover:text-(--brand-ink) hover:opacity-100"
                aria-label={t("devices.revoke")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {offerAdd && (
        // A `motion.div` around a plain button, not a `motion.button`: the
        // dashboard's specs stand `motion` in with `div` and `span` only.
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: devices.length * 0.04 + 0.06 }}
        >
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="group mt-2 flex w-full items-center gap-3 rounded-[var(--radius-item)] p-3 text-left transition-colors hover:bg-[color:var(--color-surface)]"
          data-testid="devices-add-more"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-[color:var(--color-border-strong)] text-[color:var(--brand-muted-foreground)] transition-colors group-hover:border-(--brand-ink)/60 group-hover:text-(--brand-ink)">
            <Plus className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 text-xs text-[color:var(--brand-muted-foreground)] transition-colors group-hover:text-[color:var(--brand-foreground)]">
            {freeSlots === null
              ? t(devices.length === 0 ? "devices.addUnlimitedFirst" : "devices.addUnlimited")
              : t(devices.length === 0 ? "devices.addFirst" : "devices.addMore", { count: freeSlots })}
          </span>
          <QrCode aria-hidden className="h-3.5 w-3.5 shrink-0 text-[color:var(--brand-muted-foreground)] opacity-50 transition-opacity group-hover:opacity-90" />
        </button>
        </motion.div>
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

      {/* ── Add a device: this subscription's link as a code ── */}
      <Dialog open={offerAdd && addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("devices.addTitle")}</DialogTitle>
            <DialogDescription>{t("devices.addBody")}</DialogDescription>
          </DialogHeader>
          {/* White on purpose, whatever the theme: a light concept would
              otherwise put a light code on a light plate, and a code that does
              not scan is worth less than one that does not match. Plain style,
              as on the connect sheet — VPN apps' scanners are the least
              forgiving readers there are. */}
          <div className="mt-1 flex justify-center">
            <div className="rounded-[var(--radius-card)] bg-white p-2">
              {subscriptionUrl ? (
                <LocalQr url={subscriptionUrl} label={t("devices.addTitle")} size={208} captioned={false} />
              ) : null}
            </div>
          </div>
          <p className="text-center text-xs text-[color:var(--brand-muted-foreground)]">
            {[subscriptionName, freeSlots === null ? null : t("devices.addSlots", { count: freeSlots })]
              .filter((part): part is string => Boolean(part))
              .join(" · ")}
          </p>
          <StadiumButton variant="secondary" size="md" fullWidth icon={<Copy className="h-4 w-4" />} onClick={() => void handleCopy()}>
            {t("devices.addCopy")}
          </StadiumButton>
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
