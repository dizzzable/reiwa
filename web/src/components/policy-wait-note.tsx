/**
 * PolicyWaitNote
 * ──────────────
 * The line under a spinner that waits for the access mode, once the wait has
 * gone on for {@link POLICY_WAIT_NOTE_AFTER_MS}: the panel is not answering, and
 * the cabinet keeps asking by itself — nothing to press, nothing to reload. It
 * used to spin with no word for as long as the panel was down (CD2a §9.2). Only
 * the words change: the spinner stays, the gate stays shut, and the flow
 * appears the moment the policy is read.
 *
 * A module of its own, with no icons: the app shell shows it too, and the shell
 * must not pull the banner's icon set in with it.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * How long a wait for the access mode goes on in silence. A first read answers
 * in well under a second; a wait this long is the panel not answering, with no
 * policy known to fall back on.
 */
export const POLICY_WAIT_NOTE_AFTER_MS = 10_000;

export function PolicyWaitNote({ afterMs = POLICY_WAIT_NOTE_AFTER_MS }: { readonly afterMs?: number }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!shown) return null;
  return (
    <p
      role="status"
      className="max-w-xs px-6 text-center text-sm text-(--brand-foreground)/70"
      data-testid="access-mode-pending-note"
    >
      {t("accessMode.pendingNote")}
    </p>
  );
}
