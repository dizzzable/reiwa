/**
 * NotificationBell
 * ────────────────
 * Dashboard header action (after Buy / Promo). Shows a bell with an unread
 * count badge + a light pulse when there are unread notifications. Tapping it
 * opens a modal listing the latest few news (titles + first line); tapping a
 * news item jumps to the feed with `?n=<id>` (which opens the full modal).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Bell, CheckCheck, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
} from "@/lib/api-client";
import { presentNotification } from "@/lib/notification-presenter";
import { useSupportInNav } from "@/components/layout/use-nav-tabs";
import { useSupportUnread } from "@/hooks/use-support-unread";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiText } from "@/components/ui/emoji-text";
import { cn } from "@/lib/utils";
import type { NotificationsResponse } from "@/types/api";

const RECENT_LIMIT = 5;

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: unread } = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: ({ signal }) => getUnreadCount({ signal }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const {
    data: feed,
    isError: isFeedError,
    isLoading: isFeedLoading,
    refetch: refetchFeed,
  } = useQuery({
    queryKey: ["notifications"],
    queryFn: ({ signal }) => getNotifications(1, RECENT_LIMIT, { signal }),
    enabled: open,
    staleTime: 30_000,
  });

  // When Support is a bottom-nav destination, its unread replies are surfaced
  // on that nav tab's own badge — so the bell stops counting them (it keeps
  // counting every OTHER notification type). When Support isn't in the nav the
  // bell keeps surfacing support replies too (legacy behaviour).
  const supportInNav = useSupportInNav();
  const supportUnread = useSupportUnread();
  const rawCount = unread?.count ?? 0;
  const count = supportInNav ? Math.max(0, rawCount - supportUnread) : rawCount;
  const hasUnread = count > 0;
  const bellLabel = hasUnread
    ? `${t("notifications.feedTitle")}: ${t("dashboard.unread", { count })}`
    : t("notifications.feedTitle");
  const recent = (feed?.notifications ?? [])
    .slice(0, RECENT_LIMIT)
    .map((n) => presentNotification(n, t));
  // The popup displays only the latest few rows, but this action clears the
  // entire inbox. Keep it available when an unread item is just outside the
  // compact preview as well.
  const canMarkAllRead = hasUnread && feed !== undefined;

  const markAllRead = useMutation({
    mutationFn: markAllNotificationsRead,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["notifications"] });
      await queryClient.cancelQueries({
        queryKey: ["notifications", "unread-count"],
      });

      const previousFeed = queryClient.getQueryData<NotificationsResponse>([
        "notifications",
      ]);
      const previousUnread = queryClient.getQueryData<{ count: number }>([
        "notifications",
        "unread-count",
      ]);
      const readAt = new Date().toISOString();

      queryClient.setQueryData<NotificationsResponse>(["notifications"], (current) =>
        current === undefined
          ? current
          : {
              ...current,
              notifications: current.notifications.map((notification) => ({
                ...notification,
                readAt: notification.readAt ?? readAt,
              })),
            },
      );
      queryClient.setQueryData(["notifications", "unread-count"], { count: 0 });

      return { previousFeed, previousUnread };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousFeed !== undefined) {
        queryClient.setQueryData(["notifications"], context.previousFeed);
      }
      if (context?.previousUnread !== undefined) {
        queryClient.setQueryData(
          ["notifications", "unread-count"],
          context.previousUnread,
        );
      }
      toast.error(t("notifications.markAllReadFailed"));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      queryClient.invalidateQueries({
        queryKey: ["notifications", "unread-count"],
      });
    },
  });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-pill)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)]"
        aria-label={bellLabel}
      >
        <motion.span
          className="inline-flex"
          style={{ transformOrigin: "50% 0%" }}
          animate={hasUnread ? { rotate: [0, -14, 12, -9, 7, 0] } : { rotate: 0 }}
          transition={
            hasUnread
              ? { duration: 1, repeat: Infinity, repeatDelay: 2.4, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        >
          <Bell className="h-4 w-4" />
        </motion.span>
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
        <DialogContent
          className="max-w-sm"
          aria-busy={markAllRead.isPending || undefined}
        >
          <DialogHeader>
            <DialogTitle>{t("notifications.recentTitle")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            {isFeedLoading ? (
              <p
                role="status"
                className="py-6 text-center text-sm text-[color:var(--brand-muted-foreground)]"
              >
                {t("notifications.loading")}
              </p>
            ) : isFeedError ? (
              <button
                type="button"
                onClick={() => void refetchFeed()}
                className="w-full rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] px-3 py-4 text-sm text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)]"
              >
                {t("notifications.loadFailed")}
              </button>
            ) : recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-[color:var(--brand-muted-foreground)]">
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
                    "w-full rounded-[var(--radius-item)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-3 text-left transition-colors hover:bg-[color:var(--color-surface-high)]",
                    !n.isRead && "border-(--brand-primary)/20 bg-(--brand-primary)/3",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-(--brand-primary)" />
                    )}
                    <p className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-medium text-[color:var(--brand-foreground)]">
                      <EmojiText text={n.title} />
                    </p>
                  </div>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-2 break-words text-xs text-[color:var(--brand-muted-foreground)]">
                      <EmojiText text={n.body} />
                    </p>
                  )}
                </button>
              ))
            )}
          </div>

          {canMarkAllRead && (
            <button
              type="button"
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-pill)] border border-[color:var(--color-border-soft)] px-3 py-2 text-xs font-medium text-[color:var(--brand-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] disabled:pointer-events-none disabled:opacity-60"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {t("activity.markAllRead")}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate("/settings/notifications/feed");
            }}
            className="mt-1 flex min-h-7 items-center justify-center gap-1 rounded-[var(--radius-pill)] px-2 text-xs font-medium text-(--brand-primary) hover:bg-[color:var(--color-surface-high)] hover:underline"
          >
            {t("notifications.seeAll")}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
