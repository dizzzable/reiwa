/**
 * Wheel entry icon — the cabinet's way in to the wheel of fortune.
 *
 * It hides entirely while the operator has the wheel off, which is how it
 * behaves on every install until somebody configures one: an icon that opens
 * a page saying "not available" is worse than no icon.
 *
 * A dot marks a spin waiting to be taken — free or on the balance. It is the
 * only thing this button says about the wheel: no counts, no odds, nothing
 * that would need to stay in step with the page behind it.
 */
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";

import { getContests, getWheel } from "@/lib/api-client";
import { useIconDecor } from "@/lib/icon-decor";
import { cn } from "@/lib/utils";

export function WheelIcon() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Above the early return below — hook order is not linted in this tree.
  const decor = useIconDecor("wheel");

  const { data } = useQuery({
    queryKey: ["wheel"],
    queryFn: getWheel,
    staleTime: 60_000,
  });
  const contests = useQuery({
    queryKey: ["contests"],
    queryFn: getContests,
    staleTime: 60_000,
  });

  const hasContest = (contests.data ?? []).some((contest) => contest.status === "ACTIVE");
  if (!data?.enabled && !hasContest) return null;
  const WheelGlyph = decor.Glyph ?? CircleDot;

  return (
    <button
      type="button"
      onClick={() => navigate("/events")}
      aria-label={t("events.title")}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-pill)] border border-[color:var(--color-border-soft)] bg-[color:var(--color-surface)] text-[color:var(--brand-muted-foreground)] transition-all hover:bg-[color:var(--color-surface-high)] hover:text-[color:var(--brand-foreground)]",
        decor.effectClass,
      )}
      style={decor.wrapperStyle}
    >
      <WheelGlyph className="h-4 w-4" style={decor.glyphStyle} />
      {data?.canSpin ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[color:var(--brand-accent,#fbbf24)]"
        />
      ) : null}
    </button>
  );
}
