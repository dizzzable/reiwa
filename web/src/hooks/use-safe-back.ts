/**
 * useSafeBack
 * ───────────
 * A "go back" navigator that never traps the user.
 *
 * `navigate(-1)` silently does nothing when there is no in-app history to pop —
 * which is exactly what happens inside a Telegram Mini App (no host browser
 * history) or when the user deep-links straight to a sub-page (e.g. opening the
 * Mini App on `/referrals/exchange`). The back arrow then looks broken: tapping
 * it does nothing and the user "can't exit" the screen.
 *
 * React Router records a numeric `idx` in `window.history.state` for every
 * entry it pushes. `idx === 0` means the current entry is the first one in the
 * app's own history stack, so popping would leave the app (or no-op in a TMA).
 * In that case we navigate to a sensible parent route instead.
 */
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useSafeBack(fallback = "/dashboard"): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
    } else {
      navigate(fallback, { replace: true });
    }
  }, [navigate, fallback]);
}
