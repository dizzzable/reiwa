/**
 * DevicesList
 * ───────────
 * Compact list of connected devices shown below the subscription card on the
 * dashboard. Each device shows platform icon, name, and last-seen timestamp.
 *
 * Revoke and "Regenerate link" actions are available inline. The regenerate
 * action shows a confirmation dialog (all devices will be disconnected).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { Apple, Globe, Monitor, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { HwidDevice } from "@/types/api";
import { deleteUserDevice } from "@/lib/api-client";
import { Skeleton } from "@/components/ui/skeleton";

interface DevicesListProps {
  devices: HwidDevice[];
  isLoading: boolean;
}

export function DevicesList({ devices, isLoading }: DevicesListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const revokeMutation = useMutation({
    mutationFn: (hwid: string) => deleteUserDevice(hwid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      toast.success(t("devices.revoked"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => toast.error(t("devices.error")),
  });

  // "Disconnect all" — revokes every HWID via the per-device endpoint.
  // There is no single subscription-URL reset on the backend, so we
  // fan out the existing delete call. Each device must then reconnect.
  const revokeAllMutation = useMutation({
    mutationFn: async () => {
      for (const device of devices) {
        await deleteUserDevice(device.hwid);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      toast.success(t("devices.allRevoked"));
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
    },
    onError: () => toast.error(t("devices.error")),
  });

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
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-300">
          {t("devices.title")}
        </h3>
        {devices.length > 0 && (
          <button
            onClick={() => {
              if (confirm(t("devices.revokeAllConfirm"))) {
                revokeAllMutation.mutate();
              }
            }}
            disabled={revokeAllMutation.isPending}
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${revokeAllMutation.isPending ? "animate-spin" : ""}`}
            />
            {t("devices.revokeAll")}
          </button>
        )}
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
                onClick={() => {
                  if (confirm(t("devices.revokeConfirm"))) {
                    revokeMutation.mutate(device.hwid);
                  }
                }}
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
