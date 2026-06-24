/**
 * BackButton
 * ──────────
 * Shared round "back" chrome button used in page headers across the cabinet.
 *
 * Two reasons it exists:
 *   1. Consistent liquid-glass look (`.glass-icon-btn`) instead of the mix of
 *      flat `bg-zinc-800/80` / `bg-white/5` buttons that drifted across pages.
 *   2. Safe navigation via `useSafeBack` so the arrow never dead-ends inside a
 *      Telegram Mini App or on a deep-linked page (the "can't exit" bug).
 *
 * Pass `fallback` with the parent route for the page (e.g. "/referrals" for the
 * points-exchange screen) so that when there is no in-app history to pop we
 * land somewhere sensible rather than on the default dashboard.
 */
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSafeBack } from "@/hooks/use-safe-back";

interface BackButtonProps {
  readonly fallback?: string;
  readonly label?: string;
  readonly className?: string;
}

export function BackButton({ fallback, label, className }: BackButtonProps) {
  const goBack = useSafeBack(fallback);
  return (
    <button
      type="button"
      onClick={goBack}
      aria-label={label}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:text-white glass-icon-btn",
        className,
      )}
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  );
}
