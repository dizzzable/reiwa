import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, RefreshCcw, ShieldEllipsis } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getOlcrtcSubscription,
  provisionOlcrtcSubscription,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";

const QUERY_KEY = ["olcrtc", "subscription"] as const;

export function OlcrtcCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getOlcrtcSubscription,
    staleTime: 30_000,
  });

  const provision = useMutation({
    mutationFn: provisionOlcrtcSubscription,
    onSuccess: (payload) => {
      queryClient.setQueryData(QUERY_KEY, payload);
    },
  });

  if (data?.enabled === false) return null;

  const subscription = data?.subscription ?? null;
  const ready = data?.status === "READY" && subscription !== null;
  const unavailable = data?.status === "UNAVAILABLE" || isError;
  const noActiveSubscription = data?.status === "NO_ACTIVE_SUBSCRIPTION";
  const busy = isLoading || isFetching || provision.isPending;

  const handleCopy = async () => {
    if (!subscription?.url) return;
    await copyText(subscription.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred("success");
  };

  return (
    <section className="rounded-[var(--radius-card)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-item)] bg-(--brand-primary)/15 text-(--brand-primary)">
          <ShieldEllipsis className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[color:var(--brand-foreground)]">
            {t("olcrtc.title")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[color:var(--brand-muted-foreground)]">
            {ready
              ? t("olcrtc.ready", {
                  provider: subscription.provider,
                  transport: subscription.transport,
                })
              : noActiveSubscription
                ? t("olcrtc.noSubscription")
                : unavailable
                  ? t("olcrtc.unavailable")
                  : t("olcrtc.pending")}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {ready ? (
          <Button size="sm" onClick={() => void handleCopy()}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? t("olcrtc.copied") : t("olcrtc.copy")}
          </Button>
        ) : null}
        {!ready && !noActiveSubscription ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (unavailable) {
                void provision.mutateAsync();
              } else {
                void refetch();
              }
            }}
          >
            <RefreshCcw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {unavailable ? t("olcrtc.retry") : t("olcrtc.refresh")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}
