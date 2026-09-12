/**
 * One place that decides how a PLAIN QR code is drawn.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The options lived inline at each call site and drifted apart, which is how a
 * real defect survived: the referral code was drawn with `--brand-foreground`
 * modules (near-white) on `#00000000` (fully transparent). Two independent
 * failures in one line — it is an INVERTED code, and flattening the alpha onto
 * white (saving the image, forwarding it in a messenger, printing it) leaves
 * near-white on white, which is not "hard to read" but blank.
 *
 * ── The rules, and where each comes from ────────────────────────────────────
 *
 * DARK ON LIGHT, ALWAYS. Reflectance reversal is optional in ISO/IEC 18004,
 * and support is genuinely uneven: zxing-cpp tries inversion by default,
 * ZXing Java has `ALSO_INVERTED` but OFF by default, the JS port has no such
 * hint at all, and quirc has none. The clients that matter here sit at the
 * strict end. If a dark surface needs a light-looking code, the answer is a
 * light PLATE under a dark code, never an inverted code.
 *
 * OPAQUE LIGHT FIELD. A transparent background is not a colour: it is
 * whatever the code is composited onto later, and "later" includes a white
 * PNG the customer saved.
 *
 * QUIET ZONE OF FOUR MODULES. ISO/IEC 18004 §6.3.8 sets it at 4X, and it is
 * not decoration: the encoder's mask-selection penalty N3 (40 points, the
 * largest of the four) exists to avoid producing a false finder pattern
 * bounded by a 4-module light run — the quiet zone IS the signature the
 * detector looks for. `node-qrcode` defaults to 4; both call sites had
 * overridden it downwards, to 1 and 2.
 *
 * ERROR CORRECTION STAYS AT `M` UNLESS SOMETHING IS BUYING IT. The famous
 * 7/15/25/30% are percentages of CODEWORDS, not of area — a codeword is eight
 * modules and one bad module spends the whole of it — so measured tolerance to
 * scattered damage is nearer 6/12/18/20%. Raising M→H for a real URL costs
 * between zero and five symbol versions, which at a fixed physical size means
 * modules up to ~28% smaller. Since ML Kit documents a floor of two pixels per
 * module, that trade can push a code below the threshold in exchange for
 * protection against a failure mode (scattered codeword damage) that is not
 * what actually breaks camera scans — blur, contrast and geometry are, and
 * Reed-Solomon does not touch any of them. So: raise the level only where a
 * logo or artwork is actually consuming it. (The styled renderer in `qr-style`
 * takes a higher level only when it costs nothing — the same symbol version.)
 *
 * ── No colour parameter, on purpose ─────────────────────────────────────────
 *
 * The plain code is black on white and nothing else. An operator's colour
 * reaches a code only through `qr-style`, whose `resolveQrStyle` refuses
 * anything under 7:1 against white — a floor measured by decoding, after the
 * WCAG 4.5:1 grey failed. This file used to take a palette too, guarded by a
 * check that asked only whether the modules were darker than the field; that
 * let a near-white grey through, nothing called it, and a second door into the
 * same room with a lower threshold is how the first defect happened.
 */
import type { QRCodeToStringOptions } from 'qrcode'

/** ISO/IEC 18004 §6.3.8 — 4X on all four sides. */
export const QUIET_ZONE_MODULES = 4

/**
 * Google's ML Kit is the only phone-side vendor that publishes a requirement:
 * "the smallest meaningful unit of the barcode should be at least 2 pixels
 * wide, and for 2-dimensional codes, 2 pixels tall". Independent measurement
 * across three decoder libraries puts the practical floor nearer 3-3.5, so
 * this is a hard floor to assert against, not a target to design to.
 */
export const MIN_PIXELS_PER_MODULE = 2

/**
 * The plain code: black modules on an opaque white field, a four-module quiet
 * zone, level M. Byte for byte what every operator who never opened the QR
 * setting shows — `qr-style` sends every plain style through exactly this.
 */
export function qrOptions(): QRCodeToStringOptions {
  return {
    type: 'svg',
    margin: QUIET_ZONE_MODULES,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  }
}

/**
 * Relative luminance per WCAG — what `qr-style`'s contrast floor is computed
 * from. The contrast a scanner needs is Symbol Contrast from ISO/IEC 15415 (a
 * reflectance difference, graded C at ≥40%), which is not the same measure;
 * the floor built on this one was set by decoding, not by the standard.
 */
export function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6)
  const channel = (pair: string): number => {
    const srgb = Number.parseInt(pair, 16) / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return (
    0.2126 * channel(full.slice(0, 2)) +
    0.7152 * channel(full.slice(2, 4)) +
    0.0722 * channel(full.slice(4, 6))
  )
}
