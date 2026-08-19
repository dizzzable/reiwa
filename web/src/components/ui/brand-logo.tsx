import type { CSSProperties, JSX } from "react";

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
 * `className` carries the sizing (e.g. `h-14 w-14`) on the screens that size
 * the mark in classes; `style` carries it on `EntryBrandTile`, where the size
 * is an operator setting and therefore a number, not a class. The rounding
 * arrives the same way: it used to be a hard-coded `rounded-xl`, which quietly
 * clipped 12 px off the corners of every opaque square logo regardless of the
 * plate it sat on.
 */
export function BrandLogo({
  className,
  style,
}: {
  readonly className?: string;
  readonly style?: CSSProperties;
}): JSX.Element {
  const { branding } = useBranding();
  if (branding.logoUrl) {
    return (
      <img
        src={branding.logoUrl}
        alt={branding.brandName}
        data-brand-logo="image"
        className={`${className ?? ""} object-contain`.trim()}
        style={style}
      />
    );
  }
  return (
    <ReiwaLogo
      className={`${className ?? ""} text-(--brand-primary)`.trim()}
      style={style}
      title={branding.brandName}
    />
  );
}
