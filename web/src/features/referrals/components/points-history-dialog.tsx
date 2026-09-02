/**
 * PointsHistoryDialog
 * ───────────────────
 * The points detail sheet: current balance, the ledger, and (on the
 * referrals page only) the way out to the exchange screen.
 *
 * It lives in one place because two screens open it — the referrals page's
 * "Баллы" stat row and the exchange page's "История" card — and a second
 * copy of the balance card would drift from the first the day either one
 * is restyled. `showExchangeButton` is false on the exchange page, where
 * the button would navigate to the screen the user is already reading.
 *
 * The description depends on `cashbackEnabled`: only an install that pays
 * points back on the customer's OWN purchases may say so. A panel too old
 * to report the flag leaves it `undefined`, which reads here as "no" —
 * the narrower promise is the safe one.
 */

import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StadiumButton } from "@/components/ui/stadium-button";
import { useNavigate } from "react-router";

import { PointsHistoryList } from "./points-history-list";

export interface PointsHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balance: number;
  /** Whether the operator also pays points on the customer's own purchases. */
  cashbackEnabled: boolean;
  /** False on the exchange page — the button would lead back to itself. */
  showExchangeButton: boolean;
}

export function PointsHistoryDialog({
  open,
  onOpenChange,
  balance,
  cashbackEnabled,
  showExchangeButton,
}: PointsHistoryDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("referrals.points")}</DialogTitle>
          <DialogDescription>
            {cashbackEnabled ? t("referrals.pointsHintCashback") : t("referrals.pointsHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-5 text-center">
            <p className="text-3xl font-bold">{balance}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("referrals.pointsBalance")}</p>
          </div>

          <PointsHistoryList />

          {showExchangeButton && (
            <StadiumButton
              fullWidth
              size="lg"
              glow
              icon={<Star className="h-5 w-5" />}
              onClick={() => {
                onOpenChange(false);
                navigate("/referrals/exchange");
              }}
            >
              {t("referrals.exchangePoints")}
            </StadiumButton>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
