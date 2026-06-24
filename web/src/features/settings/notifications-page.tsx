/**
 * NotificationsPage (hub)
 * ───────────────────────
 * Mirrors the Privacy page layout: a header + a list of cards. Two entries:
 *   • Лента уведомлений   → /settings/notifications/feed
 *   • Настройка уведомлений → /settings/notifications/settings
 */

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, BellRing } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";

export default function NotificationsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="min-h-full pb-6">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <BackButton fallback="/settings" label={t("common.back")} />
        <h1 className="text-lg font-semibold">{t("settings.notifications")}</h1>
      </div>

      <div className="mx-5 space-y-1.5">
        <NotificationsHubItem
          icon={<Bell className="h-5 w-5" />}
          iconBg="bg-blue-500/10 text-blue-400"
          label={t("notifications.feedTitle")}
          sublabel={t("notifications.feedSub")}
          onClick={() => navigate("/settings/notifications/feed")}
        />
        <NotificationsHubItem
          icon={<BellRing className="h-5 w-5" />}
          iconBg="bg-violet-500/10 text-violet-400"
          label={t("notifications.settingsTitle")}
          sublabel={t("notifications.settingsSub")}
          onClick={() => navigate("/settings/notifications/settings")}
        />
      </div>
    </div>
  );
}

function NotificationsHubItem({
  icon,
  iconBg,
  label,
  sublabel,
  onClick,
}: {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  sublabel: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-2xl border border-white/6 bg-white/2 p-4 transition-all hover:bg-white/4 active:scale-[0.98]"
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
        {icon}
      </div>
      <div className="flex-1 text-left">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-zinc-500">{sublabel}</p>
      </div>
    </button>
  );
}
