/**
 * Contests entry icon — the cabinet's way in to «Конкурсы».
 *
 * A mechanic of its own, beside the wheel and not inside it (the owner,
 * 30.10.2026): contests come and go, the wheel stays. So the icon is there
 * only while a contest runs, and gone the rest of the time — an icon that
 * opens «Сейчас конкурсов нет» is worse than no icon. A finished contest's
 * result is still one tap away from the notice that announced it.
 *
 * A dot marks a draw the person can still enter, in the brand colour and
 * rippling like the bell's badge (still under reduced motion). It used to ask
 * for `--brand-accent`, which nothing sets, so it was amber on every theme.
 * A leaderboard takes everybody in by itself, so it never asks for a tap and
 * never lights it.
 */
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trophy } from "lucide-react";

import { getContests } from "@/lib/api-client";
import { useIconDecor } from "@/lib/icon-decor";
import { cn } from "@/lib/utils";

export function ContestsIcon() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Above the early return below — hook order is not linted in this tree.
  const decor = useIconDecor("contests");

  const contests = useQuery({
    queryKey: ["contests"],
    queryFn: getContests,
    staleTime: 60_000,
  });

  const running = (contests.data ?? []).filter((contest) => contest.status === "ACTIVE");
  if (running.length === 0) return null;
  const open = running.some((contest) => !contest.entered && contest.closed === null);
  const Glyph = decor.Glyph ?? Trophy;

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
      <Glyph className="h-4 w-4" style={decor.glyphStyle} />
      {open ? (
        <span aria-hidden className="absolute right-1 top-1 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-(--brand-primary) opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-(--brand-primary)" />
        </span>
      ) : null}
    </button>
  );
}
