/**
 * DeleteSubscriptionDialog
 * ────────────────────────
 * Centered yes/no confirmation for self-service subscription deletion, opened
 * by a long-press on the subscription card. Deletion is final and
 * non-refundable; the copy makes that explicit. Confirm is disabled while the
 * request is in flight to prevent double submission.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { deleteSubscription } from "@/lib/api-client";
import type { Subscription } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function subscriptionTitle(sub: Subscription): string {
  return sub.profileName || sub.plan?.name || sub.id;
}

export function DeleteSubscriptionDialog({
  subscription,
  open,
  onOpenChange,
}: {
  subscription: Subscription | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteSubscription(subscription!.id),
    onSuccess: () => {
      toast.success(t("deleteSubscription.success"));
      void queryClient.invalidateQueries({ queryKey: ["subscriptions-all"] });
      void queryClient.invalidateQueries({ queryKey: ["subscription"] });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      onOpenChange(false);
    },
    onError: () => toast.error(t("deleteSubscription.error")),
  });

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
            onClick={() => mutation.mutate()}
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
