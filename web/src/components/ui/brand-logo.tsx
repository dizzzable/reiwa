import type { JSX } from "react";

import { useBranding } from "@/lib/branding-provider";
import { ReiwaLogo } from "./reiwa-logo";

/**
 * BrandLogo
 * ─────────
 * The operator-aware brand mark. Renders the uploaded `branding.logoUrl` when
 * set, otherwise the default Reiwa origami mark tinted with the brand colour.
 * Drop-in replacement for the hardcoded `<ReiwaLogo title="Reiwa">` on the
 * auth/entry screens so a white-labeled deployment shows its own logo from the
 * very first screen.
 *
 * `className` carries the sizing (e.g. `h-14 w-14`); the image variant adds
 * `object-contain` and the mark variant adds the brand tint.
 */
export function BrandLogo({ className }: { readonly className?: string }): JSX.Element {
  const { branding } = useBranding();
  if (branding.logoUrl) {
    return (
      <img
        src={branding.logoUrl}
        alt={branding.brandName}
        className={`${className ?? ""} rounded-xl object-contain`.trim()}
      />
    );
  }
  return <ReiwaLogo className={`${className ?? ""} text-(--brand-primary)`.trim()} title={branding.brandName} />;
}
