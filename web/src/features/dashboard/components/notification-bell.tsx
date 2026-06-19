/**
 * NotificationBell
 * ────────────────
 * Dashboard header action (after Buy / Promo). Shows a bell with an unread
 * count badge + a light pulse when there are unread notifications. Tapping it
 * opens a modal listing the latest few news (titles + first line); tapping a
 * news item jumps to the feed with `?n=<id>` (which opens the full modal).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bell, ChevronRight } from "lucide-react";

import { getNotifications, getUnreadCount } from "@/lib/api-client";
import { presentNotification } from "@/lib/notification-presenter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiText } from "@/components/ui/emoji-text";
import { cn } from "@/lib/utils";

const RECENT_LIMIT = 5;

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const { data: unread } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: getUnreadCount,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: feed } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications(1, RECENT_LIMIT),
    enabled: open,
    staleTime: 30_000,
  });

  const count = unread?.count ?? 0;
  const hasUnread = count > 0;
  const recent = (feed?.notifications ?? [])
    .slice(0, RECENT_LIMIT)
    .map((n) => presentNotification(n, t));

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 transition-colors hover:bg-white/6 hover:text-white"
        aria-label={t("notifications.feedTitle")}
      >
        <Bell className="h-4 w-4" />
        {hasUnread && (
          <span className="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center">
            <span className="absolute inline-flex h-4 w-4 animate-ping rounded-full bg-(--brand-primary) opacity-50" />
            <span className="relative inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-(--brand-primary) px-1 text-[9px] font-bold leading-none text-(--brand-primary-fg)">
              {count > 99 ? "99+" : count}
            </span>
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("notifications.recentTitle")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            {recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                {t("activity.emptyNotifications")}
              </p>
            ) : (
              recent.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(`/settings/notifications/feed?n=${encodeURIComponent(n.id)}`);
                  }}
                  className={cn(
                    "w-full rounded-2xl border border-white/6 bg-white/2 p-3 text-left transition-colors hover:bg-white/5",
                    !n.isRead && "border-(--brand-primary)/20 bg-(--brand-primary)/3",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-(--brand-primary)" />
                    )}
                    <p className="flex-1 truncate text-sm font-medium text-white">
                      <EmojiText text={n.title} />
                    </p>
                  </div>
                  {n.body && (
                    <p className="mt-0.5 truncate text-xs text-zinc-400">
                      <EmojiText text={n.body} />
                    </p>
                  )}
                </button>
              ))
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/settings/notifications/feed");
            }}
            className="mt-1 flex items-center justify-center gap-1 text-xs font-medium text-(--brand-primary) hover:underline"
          >
            {t("notifications.seeAll")}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
