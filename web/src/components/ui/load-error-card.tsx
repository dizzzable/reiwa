/**
 * LoadErrorCard
 * ─────────────
 * Inline "we could not load this, it's ours and it's temporary" card with a
 * retry affordance. Lifted verbatim from the FAQ page's load-failure block
 * (`faq-page.tsx`) so screens that must distinguish "the read failed" from
 * "there is nothing here" share ONE look instead of growing a new one each
 * time.
 *
 * Retry calls TanStack Query's `refetch`; `pending` disables the button while
 * a refetch is in flight so an impatient tap cannot queue requests at a panel
 * that is already down. Backoff itself stays where the app configures it
 * (`lib/query-client.ts`, `retry: 1`) — this component adds none.
 */
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LoadErrorCardProps {
  readonly title: string;
  readonly body: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly pending?: boolean;
  readonly className?: string;
}

export function LoadErrorCard({
  title,
  body,
  retryLabel,
  onRetry,
  pending = false,
  className,
}: LoadErrorCardProps) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-left",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-100">{title}</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/80">{body}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={pending}
          className="border-amber-300/30 bg-transparent text-amber-100 hover:bg-amber-500/10 hover:text-amber-50"
        >
          {retryLabel}
        </Button>
      </div>
    </div>
  );
}
