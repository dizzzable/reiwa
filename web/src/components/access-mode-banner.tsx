/**
 * AccessModeBanner
 * ────────────────
 * Renders a localised notice when the platform is running in a non-PUBLIC
 * access mode. Drop it at the top of a page; it self-hides under PUBLIC
 * (and under modes irrelevant to the page, controlled by the `modes` prop).
 */
import { TriangleAlert, Wrench, Ban, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAccessMode } from "@/lib/use-access-mode";
import type { AccessMode } from "@/types/api";

const ICON: Record<Exclude<AccessMode, "PUBLIC">, typeof TriangleAlert> = {
  RESTRICTED: Wrench,
  PURCHASE_BLOCKED: Ban,
  REG_BLOCKED: Ban,
  INVITED: Mail,
};

export function AccessModeBanner({
  modes,
  className = "",
}: {
  /** Which non-PUBLIC modes this banner should render for. */
  modes: ReadonlyArray<Exclude<AccessMode, "PUBLIC">>;
  className?: string;
}) {
  const { t } = useTranslation();
  const { mode } = useAccessMode();

  if (mode === "PUBLIC") return null;
  if (!modes.includes(mode)) return null;

  const Icon = ICON[mode];
  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-200 ${className}`}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{t(`accessMode.banner.${mode}.title`)}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-amber-200/80">
          {t(`accessMode.banner.${mode}.body`)}
        </p>
      </div>
    </div>
  );
}

/**
 * Full-page "this flow is gated" screen — a centered banner + a back
 * button. Used by purchase / upgrade / addons / renewal pages when the
 * current access mode forbids the flow.
 */
export function AccessModeBlockedScreen({
  modes,
  onBack,
}: {
  modes: ReadonlyArray<Exclude<AccessMode, "PUBLIC">>;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-5 pt-16">
      <AccessModeBanner modes={modes} />
      <button
        onClick={onBack}
        className="mx-auto mt-2 rounded-full bg-white/5 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/10 active:scale-95"
      >
        {t("common.back")}
      </button>
    </div>
  );
}
