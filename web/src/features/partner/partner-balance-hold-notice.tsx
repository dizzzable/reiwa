import { useTranslation } from "react-i18next";

import { TipCard } from "@/components/ui/tip-card";
import { formatHoldEnd, type PartnerBalanceHold } from "@/lib/partner-balance-hold";

/**
 * Stands beside a «pay with the partner balance» button the hold has disabled:
 * the balance is on hold for now, because the password was recovered with the
 * subscription link, and until when — in the operator's time zone, or in UTC
 * named as such (`formatHoldEnd`). `id` lets the button point at it with
 * `aria-describedby`, so a screen reader hears why the button does nothing.
 */
export function PartnerBalanceHoldNotice({ hold, id }: { hold: PartnerBalanceHold; id: string }) {
  const { t, i18n } = useTranslation();
  return (
    <TipCard tone="warning" id={id}>
      {t("partnerBalanceHold.notice", { until: formatHoldEnd(hold.until, hold.timezone, i18n.language) })}
    </TipCard>
  );
}
