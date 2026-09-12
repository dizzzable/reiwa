/**
 * Local QR code (no third-party pixel). Uses the `qrcode` package already in
 * reiwa/web dependencies.
 *
 * ── Vector, not raster, and that is the load-bearing part ───────────────────
 *
 * This used to call `toDataURL({ width: size })`, which produces a bitmap
 * exactly `size` pixels across and then hands it to an `<img>` sized in CSS
 * pixels. On a 3x phone the browser upscales it threefold and the module edges
 * smear. That matters more than it sounds: what decides whether a camera can
 * read a code is pixels per module — ML Kit documents a floor of two, and
 * measurement across decoder libraries puts the practical floor nearer three —
 * and blur eats exactly that budget. Error correction does not help here at
 * all: blur degrades the finder and timing patterns too, and those sit outside
 * the Reed-Solomon stream entirely, so a symbol whose sampling grid was never
 * resolved is never corrected, it is simply not found.
 *
 * An SVG has no resolution to lose. It is NOT smaller, whatever intuition
 * says: percent-encoded into a data URL the markup runs 2105 bytes against the
 * PNG's 1470 at 96 px, and 5168 against 4110 at 208 px. The trade is a few
 * hundred bytes for module edges a camera can still resolve — worth making,
 * and worth stating in the direction it actually runs.
 *
 * The quiet zone, the error-correction level and the plain path all come from
 * `qr-style` and `qr-options`, through `qrSvg` — see the reasoning there,
 * including the inverted-code defect that made a shared module worth having.
 *
 * ── Whether a code is styled is the CALLER's decision ───────────────────────
 *
 * This component does not read the branding, and must not. The connect sheet
 * renders it too, for the subscription link that VPN clients' in-app scanners
 * read — the least forgiving readers there are — and a component that looked
 * the operator's style up for itself would style that code without anyone
 * deciding to. So the style is a prop, and it defaults to plain: `qrcode`'s own
 * writer through `qrOptions()`, byte for byte what every unstyled code in this
 * build gets, the connect code included.
 *
 * That baseline is not the bitmap this component drew before the setting
 * existed: the old one came out of `toDataURL` with a one-module quiet zone,
 * and this patch moved BOTH — raster to vector, quiet zone to the standard
 * four — for every plain code in the cabinet, connect included. See
 * `qr-options` for why. What the default guarantees is the owner's rule
 * itself: no code becomes STYLED unless somebody chose it. The
 * call sites that may be styled resolve the operator's style and hand it in;
 * the connect sheet hands in nothing.
 */
import { useEffect, useState } from "react";

import { QR_STYLE_PLAIN, qrSvg, type QrStyle } from "@/lib/qr-style";

export function LocalQr({
  url,
  label,
  size = 96,
  captioned = true,
  style = QR_STYLE_PLAIN,
}: {
  url: string;
  label: string;
  size?: number;
  /**
   * The caption under the code. On by default because that is what the two
   * callers that came first need; off where the code already sits under a
   * heading that says the same thing, and repeating it there reads as a
   * mistake. `label` stays the alt text either way — a code with no accessible
   * name is a picture nobody can identify.
   */
  captioned?: boolean;
  /**
   * How to draw the code. Absent means plain: exactly the code every operator
   * who never opened the setting has.
   *
   * Nothing here checks whether a style is scannable, and nothing needs to.
   * The call sites that style a code take it from `resolveQrStyle`, which has
   * already refused anything a scanner could not read — a colour with less
   * than 7:1 contrast against white, a shape this build does not draw — and
   * answered with a safe fallback before the style ever reached this prop.
   *
   * MEMOISE IT. The style object is a dependency of the effect that draws the
   * code, so a caller that builds it inline, or calls `resolveQrStyle` during
   * render without `useMemo`, hands in a new object on every render and
   * re-encodes the code each time.
   */
  style?: QrStyle;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `size` is the CSS size the code is shown at. On a styled code it decides
    // whether dots are still large enough in pixels or step down to rounded
    // squares; a plain code is vector and does not depend on it.
    void qrSvg(url, style, size)
      .then((svg) => {
        if (cancelled) return;
        // `encodeURIComponent` rather than base64: the payload is ASCII markup,
        // so the data URL stays readable in devtools. Readability is the whole
        // of the trade — percent encoding is a shade LONGER than base64 on this
        // markup, 2105 bytes against 2082 at 96 px, not shorter.
        setDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url, style, size]);

  if (!dataUrl) {
    return (
      <div className="flex flex-col items-center gap-1">
        {/* The box the finished code occupies, built the same way — the plate's
            own padding is what makes it `size + 8`. A placeholder sized `size`
            moved the caption, and everything under it, by eight pixels the
            moment the code arrived. */}
        <div className="overflow-hidden rounded-md bg-white/10 p-1">
          <div style={{ width: size, height: size }} aria-hidden />
        </div>
        {captioned && <span className="text-[9px] text-muted-foreground">{label}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1">
      {/* The plate is rounded and it clips. `overflow-hidden` is what stops a
          square white image from squaring off the plate's corners over the dark
          sheet — and it clips the CODE with it. Moving the radius off the image
          onto this wrapper did not change that by a pixel: measured in Chrome,
          an image's own `border-radius` and a parent's `overflow` clip both
          round the image at `radius − padding`, around the image's own box. (A
          radius no larger than the padding therefore clips nothing at all.)

          `rounded-md` is the OPERATOR's radius here, not a constant:
          `--radius-md` is `calc(var(--radius) * 0.8)` and `--radius` is
          `cornerRadii.itemPx` — 11.2px by default, 25.6px at the panel's
          maximum of 32. The corner bite is 0.29 × (radius − 4px) along the
          diagonal: 2.1px, up to 6.3px.

          What keeps that off the finder patterns — the three things a decoder
          locates the symbol by — is the QUIET ZONE inside the SVG, four modules
          wide (`qr-options`). A code large enough to scan has two pixels per
          module or better, so the zone is at least 8px: wider than the deepest
          bite at every radius an operator can set. At the ONE module both call
          sites used to ask for, the zone was 2.8px on a 96px partner code —
          narrower than the bite for any item radius past about 17, so a brand
          with round corners was losing part of a finder. */}
      <div className="overflow-hidden rounded-md bg-white p-1">
        <img src={dataUrl} alt={label} width={size} height={size} />
      </div>
      {captioned && <span className="text-[9px] text-muted-foreground">{label}</span>}
    </div>
  );
}
