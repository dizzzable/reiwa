/**
 * DeleteSubscriptionDialog
 * ────────────────────────
 * Centered yes/no confirmation for self-service subscription deletion, opened
 * by the card delete button or its long-press shortcut. Deletion is final and
 * non-refundable; the copy makes that explicit. Confirm is disabled while the
 * request is in flight to prevent double submission.
 */
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import axios from "axios";

import { deleteSubscription } from "@/lib/api-client";
import type { Subscription } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { executeSubscriptionDeleteWithAmbiguousRetry } from "../subscription-delete-policy";

function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

export function DeleteSubscriptionDialog({
  subscription,
  open,
  onOpenChange,
  onDeleteStarted,
  onServerCommitted,
  onServerRejected,
}: {
  subscription: Subscription | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleteStarted: (subscriptionId: string) => void;
  onServerCommitted: (subscriptionId: string) => void;
  onServerRejected: (subscriptionId: string) => void;
}) {
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      await executeSubscriptionDeleteWithAmbiguousRetry(
        () => deleteSubscription(subscriptionId),
        (error) =>
          axios.isAxiosError(error) && error.response === undefined,
      );
      return subscriptionId;
    },
    onSuccess: (subscriptionId) => {
      toast.success(t("deleteSubscription.success"));
      onServerCommitted(subscriptionId);
    },
    onError: (_error, subscriptionId) => {
      toast.error(t("deleteSubscription.error"));
      onServerRejected(subscriptionId);
    },
  });

  const confirmDeletion = () => {
    const subscriptionId = subscription?.id;
    if (!subscriptionId || mutation.isPending) return;
    // Start the presentation before the request. Closing the modal immediately
    // reveals the card underneath while the DELETE continues independently.
    onDeleteStarted(subscriptionId);
    onOpenChange(false);
    mutation.mutate(subscriptionId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (mutation.isPending) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-400">
            <TriangleAlert className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center">{t("deleteSubscription.title")}</DialogTitle>
          <DialogDescription className="text-center">
            {t("deleteSubscription.body", {
              name: subscription ? subscriptionTitle(subscription) : "",
            })}
          </DialogDescription>
        </DialogHeader>

        <p className="text-center text-xs text-zinc-500">{t("deleteSubscription.warning")}</p>

        <div className="mt-2 grid grid-cols-2 gap-3">
          <button
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
            className="rounded-2xl border border-white/10 py-3 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/5 active:scale-[0.98] disabled:opacity-50"
          >
            {t("deleteSubscription.no")}
          </button>
          <button
            onClick={confirmDeletion}
            disabled={mutation.isPending || !subscription}
            className="flex items-center justify-center gap-2 rounded-2xl bg-red-500/90 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 active:scale-[0.98] disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("deleteSubscription.yes")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
