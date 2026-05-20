/**
 * NotificationsPage
 * ─────────────────
 * Notification preferences for subscription expiry alerts.
 * Users can toggle which reminders they receive.
 */

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function NotificationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // TODO: wire to user notification preferences API
  // For now, all toggles are visual-only (defaults shown)

  return (
    <div className="min-h-full pb-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{t("notifications.title")}</h1>
      </div>

      <div className="mx-5 space-y-6">
        {/* Before expiry */}
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

        {/* After expiry */}
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

function NotifToggle({ label, defaultChecked }: { label: string; defaultChecked: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm text-zinc-300 cursor-pointer">{label}</Label>
      <Switch defaultChecked={defaultChecked} />
    </div>
  );
}
