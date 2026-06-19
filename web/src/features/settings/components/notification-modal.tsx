/**
 * NotificationModal
 * ─────────────────
 * Full-content view of a single notification / broadcast. The feed shows only
 * the title + first sentence; tapping a broadcast opens this dialog with the
 * complete body (custom-emoji shortcodes animated via `EmojiText`) and date.
 */
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiText } from "@/components/ui/emoji-text";
import { formatDateTime } from "@/lib/utils";
import type { PresentedNotification } from "@/types/api";

export function NotificationModal({
  notification,
  open,
  onOpenChange,
}: {
  readonly notification: PresentedNotification | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!notification) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="pr-6">
            <EmojiText text={notification.title} />
          </DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-zinc-500">
          {formatDateTime(notification.createdAt)}
        </p>
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
          {notification.body
            ? <EmojiText text={notification.body} />
            : <span className="text-zinc-500">{t("notifications.emptyBody")}</span>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
