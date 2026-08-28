/**
 * ReferralInviteCard (desktop sidebar)
 * ────────────────────────────────────
 * A compact promo for the referral program, pinned above the sign-out control.
 *
 * Everything it says is a claim about what the payout engine will actually do,
 * so all of it comes from `/referrals/summary` rather than from anything this
 * bundle believes:
 *
 *   • `program.enabled` mirrors the operator kill-switch the engine reads. Only
 *     an explicit `false` disables, exactly as `qualifyReferralAfterPurchase`
 *     treats it — a stricter reading here would hide a program that is still
 *     paying out.
 *   • `program.reward` is `null` whenever the engine would create nothing at
 *     level 1, so a card with a reward line is a promise the engine keeps.
 *   • The UNIT is the operator's choice (points or days). Hardcoding either one
 *     would be wrong on every install that picked the other.
 *   • `programAvailable` is the per-user invited-only gate: the program can be
 *     on while this particular person may not take part.
 *
 * An older panel sends no `program` key at all. That case renders nothing: the
 * card is entirely a reward promise, and there is no truthful one to make
 * without those terms. `/referrals` stays reachable either way.
 *
 * The partner case is handled by the CALLER, not here — see the mount site in
 * `side-nav.tsx`.
 *
 * Theming: no literal colours. The operator's palette arrives as CSS custom
 * properties written by `applyBrandingToDocument`, and the corner radius rides
 * on the Tailwind radius scale, which that same writer feeds through
 * `--radius`. So the card follows both the chosen theme and the chosen
 * geometry without knowing either.
 */

import { useQuery } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

import { getReferralSummary } from "@/lib/api-client";

export function ReferralInviteCard() {
  const { t } = useTranslation();

  // Same key and staleTime as the referrals page, so the two share one request
  // instead of racing for the same answer.
  const { data: summary } = useQuery({
    queryKey: ["referrals", "summary"],
    queryFn: getReferralSummary,
    staleTime: 30_000,
  });

  const program = summary?.program;
  if (!program?.enabled || summary?.programAvailable === false) return null;

  const reward = program.reward;
  // No configured reward is not a reason to hide the card: under INVITED
  // access an invite is what admits a friend at all, which is worth surfacing
  // on its own. It IS a reason not to name a number.
  const promise = reward
    ? t(reward.type === "EXTRA_DAYS" ? "referrals.cardRewardDays" : "referrals.cardRewardPoints", {
        count: reward.amount,
      })
    : t("referrals.subtitle");

  const invited = summary?.totalReferrals ?? 0;
  const qualified = summary?.qualifiedReferrals ?? 0;

  return (
    <NavLink
      to="/referrals"
      data-testid="side-referral-card"
      className="group relative block overflow-hidden rounded-2xl border border-[var(--color-border-soft)] bg-[color-mix(in_oklab,var(--brand-primary)_8%,var(--color-surface-high))] p-3 transition-colors duration-200 hover:border-[color-mix(in_oklab,var(--brand-primary)_45%,transparent)]"
    >
      {/* Brand-tinted bloom. Decorative, and derived from the operator's own
          accent, so it cannot clash with a palette it has never seen. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-8 -right-6 size-20 rounded-full bg-[var(--color-brand-glow)] opacity-60 blur-2xl"
      />

      <div className="relative flex items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--brand-primary)] text-[var(--brand-primary-fg)]">
          <Gift className="size-4" strokeWidth={2} />
        </span>
        <span className="truncate text-sm font-semibold text-[var(--brand-foreground)]">
          {t("referrals.cardTitle")}
        </span>
      </div>

      <p className="relative mt-1.5 text-xs leading-snug text-[var(--brand-muted-foreground)]">
        {promise}
      </p>

      {/* Only once there is something to count. A row of zeros on the day a
          user signs up reads as a program that does not work. */}
      {invited > 0 && (
        <div className="relative mt-2.5 grid grid-cols-2 gap-2 border-t border-[var(--color-border-soft)] pt-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums text-[var(--brand-foreground)]">
              {invited}
            </div>
            <div className="truncate text-[11px] text-[var(--brand-muted-foreground)]">
              {t("referrals.invited")}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums text-[var(--brand-primary)]">
              {qualified}
            </div>
            <div className="truncate text-[11px] text-[var(--brand-muted-foreground)]">
              {t("referrals.qualified")}
            </div>
          </div>
        </div>
      )}
    </NavLink>
  );
}
