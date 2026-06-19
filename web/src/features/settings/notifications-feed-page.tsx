/**
 * NotificationsFeedPage
 * ─────────────────────
 * Feed of received notifications (cabinet feed / UserNotificationEvent).
 * Reached from the Notifications hub or the dashboard bell. Each row shows the
 * title + first sentence; tapping a broadcast opens a full-content modal, while
 * actionable types (expiry → renew, referral → referral cabinet) route to the
 * relevant page. A `?n=<id>` deep-link (bell / push) auto-opens that item.
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { ArrowLeft, Bell, CheckCheck } from "lucide-react";

import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/api-client";
import { presentNotification } from "@/lib/notification-presenter";
import { resolveNotificationTarget } from "@/lib/notification-target";
import { StadiumButton } from "@/components/ui/stadium-button";
import { EmojiText } from "@/components/ui/emoji-text";
import { NotificationModal } from "./components/notification-modal";
import { cn, formatDateTime } from "@/lib/utils";
import type { PresentedNotification } from "@/types/api";

/** First sentence (or first line) of a body, for the compact feed preview. */
function firstSentence(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  const sentence = (match ? match[0] : trimmed).trim();
  return sentence.length < trimmed.length ? sentence : trimmed;
}

export default function NotificationsFeedPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => getNotifications(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["notifications", "unread-count"] });
  };

  const markAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: invalidate,
  });
  const markOne = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: invalidate,
  });

  const items = (data?.notifications ?? []).map((n) => presentNotification(n, t));
  const unreadCount = items.filter((n) => !n.isRead).length;
  const selected: PresentedNotification | null =
    openId !== null ? (items.find((n) => n.id === openId) ?? null) : null;

  function openNotification(n: PresentedNotification): void {
    if (!n.isRead) markOne.mutate(n.id);
    const target = resolveNotificationTarget(n.type);
    if (target.kind === "route") {
      navigate(target.path);
      return;
    }
    setOpenId(n.id);
  }

  // Deep-link: `?n=<id>` (from the dashboard bell or a push click) auto-opens
  // that notification's modal and marks it read. Cleared once consumed so a
  // back-nav / refresh doesn't re-open it.
  const deepLinkId = searchParams.get("n");
  useEffect(() => {
    if (!deepLinkId || items.length === 0) return;
    const hit = items.find((n) => n.id === deepLinkId);
    if (!hit) return;
    setOpenId(hit.id);
    if (!hit.isRead) markOne.mutate(hit.id);
    const next = new URLSearchParams(searchParams);
    next.delete("n");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, data]);

  return (
    <div className="min-h-full pb-6">
      <div className="flex items-center gap-3 px-5 pt-6 pb-4">
        <button
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/6 bg-white/3 text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">{t("notifications.feedTitle")}</h1>
      </div>

      {unreadCount > 0 && (
        <div className="flex justify-end px-5 mb-3">
          <StadiumButton
            size="sm"
            variant="ghost"
            onClick={() => markAll.mutate()}
            loading={markAll.isPending}
            icon={<CheckCheck className="h-4 w-4" />}
          >
            {t("activity.markAllRead")}
          </StadiumButton>
        </div>
      )}

      <div className="px-5 space-y-2">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl bg-zinc-800/50" />
          ))
        ) : !items.length ? (
          <div className="flex flex-col items-center gap-3 py-16 text-zinc-500">
            <Bell className="h-10 w-10 opacity-30" />
            <p className="text-sm">{t("activity.emptyNotifications")}</p>
          </div>
        ) : (
          items.map((n, i) => (
            <motion.button
              key={n.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => openNotification(n)}
              className={cn(
                "glass-card w-full p-4 text-left cursor-pointer transition-all",
                !n.isRead && "border-(--brand-primary)/20 bg-(--brand-primary)/3",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.isRead && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-(--brand-primary)" />
                    )}
                    <p className="text-sm font-medium text-white truncate">{n.title}</p>
                  </div>
                  <p className="mt-1 text-xs text-zinc-400 line-clamp-1">
                    <EmojiText text={firstSentence(n.body)} />
                  </p>
                </div>
                <p className="shrink-0 text-xs text-zinc-600">{formatDateTime(n.createdAt)}</p>
              </div>
            </motion.button>
          ))
        )}
      </div>

      <NotificationModal
        notification={selected}
        open={openId !== null}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
      />
    </div>
  );
}
