import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

interface CustomIconViewProps {
  /** Public icon URL. Served same-origin via reiwa-api's `/uploads/icons` proxy. */
  url: string;
  /** Optional hex tint. When set, the glyph is recoloured via a CSS mask. */
  color?: string | null;
  className?: string;
}

/**
 * Renders an operator-uploaded custom icon (mirrors the admin's renderer).
 *
 * With `color` set, the icon draws as a CSS mask filled with that colour, so a
 * monochrome glyph recolours to any use site. Without it, the asset renders
 * as-is (keeps multicolour art). Sized by `className` (defaults to a square).
 */
export function CustomIconView({ url, color, className }: CustomIconViewProps) {
  const base: CSSProperties = {
    backgroundColor: color ?? undefined,
    backgroundImage: color ? undefined : `url("${url}")`,
    backgroundSize: "contain",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  };
  const masked: CSSProperties = color
    ? {
        WebkitMaskImage: `url("${url}")`,
        maskImage: `url("${url}")`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }
    : {};

  return (
    <span
      aria-hidden
      className={cn("inline-block h-6 w-6 shrink-0", className)}
      style={{ ...base, ...masked }}
    />
  );
}
