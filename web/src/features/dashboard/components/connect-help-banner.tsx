/**
 * ConnectHelpBanner — «Не получилось подключиться?» on the dashboard.
 *
 * For the customer the panel could reach no other way: no bot, no push, no
 * verified e-mail. For them the cabinet is the only channel left, and only
 * when they open it — so the banner stays until they connect or close it,
 * where a pop-up would have been shown once and gone.
 *
 * The CARD ON SCREEN only. A customer with two subscriptions sees the banner
 * under the one that is waiting, and swiping to the other takes it away:
 * «подписка активна, но VPN ещё ни разу не подключался» under a card that
 * connected long ago would be a sentence about the wrong subscription.
 *
 * Shaped like `TipCard` — the accent rule down the left edge — but painted
 * with the brand tokens rather than a fixed palette, so it reads on a light
 * theme as well as on the default dark one.
 *
 * ── × is optimistic ──────────────────────────────────────────────────────
 *
 * The banner goes the moment it is pressed, and the panel is told after. The
 * panel records it, so the banner does not come back on another device. If
 * the write fails the banner stays gone for this visit and may return on the
 * next, which is honest: nothing was saved.
 */
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, X } from "lucide-react";

import { StadiumButton } from "@/components/ui/stadium-button";
import { dismissConnectHelp } from "@/lib/api-client/subscription";
import { subscriptionQueryKeys } from "@/lib/subscription-query-keys";
import type { AllSubscriptionsResponse, Subscription } from "@/types/api";

import { shouldShowConnectHelpBanner, withConnectHelpBannerHidden } from "../connect-help";

export function ConnectHelpBanner({
  subscription,
  onConnect,
}: {
  /** The card on screen, or `null` while no subscription card is. */
  readonly subscription: Subscription | null;
  /** «Подключить» — the dashboard's door, the same as its own button. */
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const titleId = useId();
  // Kept for the life of the page, not of the card: swiping away and back
  // must not bring back a banner the customer has just closed.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  if (!shouldShowConnectHelpBanner(subscription, dismissed)) return null;

  const subscriptionId = subscription.id;
  const hasUrl = typeof subscription.url === "string" && subscription.url.length > 0;

  const dismiss = (): void => {
    setDismissed((current) => new Set(current).add(subscriptionId));
    // The cached list too, so the dashboard opened again within the list's
    // freshness window does not draw it from the copy it already holds.
    queryClient.setQueryData<AllSubscriptionsResponse>(subscriptionQueryKeys.all, (current) =>
      withConnectHelpBannerHidden(current, subscriptionId),
    );
    void dismissConnectHelp(subscriptionId).catch(() => undefined);
  };

  return (
    <section
      data-testid="connect-help-banner"
      aria-labelledby={titleId}
      className="relative mx-5 mt-4 flex items-start gap-3 rounded-xl border-l-4 border-l-(--brand-primary)/60 bg-(--brand-primary)/10 p-4 pr-11 text-sm leading-relaxed"
    >
      <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0 text-(--brand-primary)" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <p id={titleId} className="font-semibold text-[color:var(--brand-foreground)]">
          {t("connectHelp.bannerTitle")}
        </p>
        <p className="text-[color:var(--brand-muted-foreground)]">{t("connectHelp.bannerBody")}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <StadiumButton
            size="sm"
            // The same guard as the card's own «Подключить»: without a link
            // there is nothing either door could hand over.
            disabled={!hasUrl}
            onClick={onConnect}
            data-testid="connect-help-connect"
          >
            {t("connectHelp.connect")}
          </StadiumButton>
          <StadiumButton
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigate("/support");
            }}
            data-testid="connect-help-support"
          >
            {t("connectHelp.support")}
          </StadiumButton>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("connectHelp.dismiss")}
        title={t("connectHelp.dismiss")}
        data-testid="connect-help-dismiss"
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-[color:var(--brand-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)]"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </section>
  );
}
