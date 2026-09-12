/**
 * Styled QR codes — drawn from the matrix, for the places an operator chose to
 * style, and ONLY there.
 *
 * ── The owner's rule, which this file exists to keep ────────────────────────
 *
 * By default a QR code looks exactly as it does today: plain black on white,
 * drawn by `qrcode`'s own SVG writer through `qrOptions()`. Styling appears only
 * where the operator turned it on — never a subscriber's choice, never a new
 * default. For a plain style `qrSvg` keeps the untouched path — `qrcode`'s own
 * writer through `qrOptions()` — so it draws the same bytes as every other
 * unstyled code in this build.
 *
 * ── What may be styled, and what may not ────────────────────────────────────
 *
 * A decoder does not read a module by its area. ZXing's grid sampler reads ONE
 * pixel at the module's centre, `(x + 0.5, y + 0.5)`, with no averaging. So a
 * data module may be any shape that keeps its centre filled — a rounded square,
 * a large dot — and the bit survives by construction.
 *
 * The FUNCTION patterns are a different matter, and they stay as the standard
 * draws them:
 *
 *   - the three finder patterns are how a decoder locates the symbol at all —
 *     a run-length test for 1:1:3:1:1 along lines through their centres, graded
 *     separately as "fixed pattern damage" by ISO/IEC 15415;
 *   - timing and alignment patterns set the sampling grid;
 *   - format information has two copies protected by a BCH code that tolerates
 *     THREE bit errors each — against hundreds of correctable bits in the data.
 *
 * None of these is covered by the Reed-Solomon code that protects the data, so
 * no amount of error correction rescues a finder that was drawn as dots. The
 * matrix marks every function module (`BitMatrix.reservedBit`); those are drawn
 * as solid squares. The one concession is `eyes: 'rounded'`, which rounds only
 * the CORNERS of the finders — the lines through their centres, which the
 * 1:1:3:1:1 test reads, are untouched.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 *
 * Dark modules on an opaque white field, always. The colour of the modules is
 * the operator's, but only if it is dark enough: at least 7:1 against white,
 * relative luminance ≤ 0.1. Anything lighter falls back to black rather than
 * drawing a code the least forgiving reader cannot see.
 *
 * The floor is NOT WCAG's 4.5:1, and that is measured rather than cautious. 4.5
 * is a rule for TEXT. The classic 4.5:1 grey, `#767676`, drawn with rounded
 * modules on the long subscription link, failed to decode through the camera
 * model in `qr-style-decodes.test.ts` — pixels that integrate light, a little
 * defocus, a grid that does not line up — while black and a brand navy passed
 * the very same case. A grey module blurred together with its white neighbours
 * drifts toward the binariser's threshold, and a dense link has no error
 * correction to spare for it. 7:1, WCAG's AAA line, is the floor those tests
 * hold the palest allowed grey to.
 *
 * There is no gradient: the gallery path of v2rayNG binarises with a GLOBAL
 * threshold, and a gradient whose palest dark module is lighter than its
 * darkest light one fails there outright.
 *
 * ── Error correction ────────────────────────────────────────────────────────
 *
 * A styled code gets the highest level that fits in the SAME symbol version as
 * `M` — `Q` on some short links, at no cost in size. Not `H`: in byte mode it is
 * free only up to a seven-byte payload, so no URL ever gets it, and every link
 * the cabinet draws today (36-139 bytes) stays at `M`. Raising the level past a
 * free one would shrink every module, and module size in pixels, not the
 * correction level, is what decides whether a camera reads a code.
 */
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode'

import { QUIET_ZONE_MODULES, qrOptions, relativeLuminance } from './qr-options'

export type QrModuleShape = 'square' | 'rounded' | 'dots'
export type QrEyeShape = 'square' | 'rounded'

export interface QrStyle {
  readonly modules: QrModuleShape
  readonly eyes: QrEyeShape
  /** The dark colour of modules and eyes. The field is always opaque white. */
  readonly dark: string
}

export const QR_STYLE_PLAIN: QrStyle = { modules: 'square', eyes: 'square', dark: '#000000' }

const MODULE_SHAPES: readonly QrModuleShape[] = ['square', 'rounded', 'dots']
const EYE_SHAPES: readonly QrEyeShape[] = ['square', 'rounded']

const LIGHT = '#ffffff'
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * 7:1 against white ⇔ relative luminance of the dark colour ≤ this (0.1).
 * `#595959` is the palest grey that passes (7.00:1); `#5a5a5a` (6.90:1) does not.
 */
export const MAX_DARK_LUMINANCE = 1.05 / 7 - 0.05

/** Corner radius of a rounded data module, in modules. Its centre stays filled. */
export const ROUNDED_MODULE_RADIUS = 0.3
/** Radius of a dot, in modules: diameter 0.86 — far above the 1/3 a centre-sampling decoder needs. */
export const DOT_RADIUS = 0.43
/**
 * Below this many pixels per module, dots become rounded squares. At small
 * sizes the camera's own blur averages a dot with the white around it and the
 * centre stops reading as dark; a rounded square keeps more ink there.
 */
export const MIN_PIXELS_PER_MODULE_FOR_DOTS = 4

/** Eye corner radii, in modules: outer ring (of 7), its white hole (of 5), the core (of 3). */
export const EYE_RADII = { outer: 1.6, hole: 1.1, core: 0.8 } as const

export type QrShape =
  | {
      readonly kind: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      /** Corner radius, 0 for a sharp square. */
      readonly r: number
      readonly fill: string
    }
  | {
      readonly kind: 'circle'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly fill: string
    }

export interface QrDrawing {
  /** Modules across, quiet zone included. The SVG's viewBox is `0 0 size size`. */
  readonly size: number
  /** In paint order: later shapes cover earlier ones. */
  readonly shapes: readonly QrShape[]
  readonly version: number
  readonly errorCorrectionLevel: QRCodeErrorCorrectionLevel
}

export interface DrawQrOptions {
  /** Pixels per module, when the caller already knows it (tests do). */
  readonly pixelsPerModule?: number
  /**
   * The size the code will be SHOWN at, in CSS pixels. Used to derive pixels per
   * module once the symbol size is known. CSS pixels rather than device pixels
   * on purpose: what decides a camera read is the code's physical size, and CSS
   * pixels track that, where a phone's 3× device pixels would overstate it.
   */
  readonly displayPixels?: number
}

/**
 * Any input → a style that is safe to draw. Never throws: this is read from a
 * branding payload, and the cabinet's snapshot guard throws the WHOLE brand away
 * on the first reader that refuses — so refusing belongs to the panel, where
 * there is an operator to tell, and this answers every input with a valid style.
 * `Object.hasOwn`, because `raw['constructor']` on a plain object is a function
 * inherited from the prototype, not a missing key.
 */
export function resolveQrStyle(raw: unknown): QrStyle {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return QR_STYLE_PLAIN
  const record = raw as Record<string, unknown>
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined)

  const dark = normalizeHex(own('dark'))
  return {
    modules: pick(own('modules'), MODULE_SHAPES, 'square'),
    eyes: pick(own('eyes'), EYE_SHAPES, 'square'),
    dark: dark !== null && isUsableDark(dark) ? dark : QR_STYLE_PLAIN.dark,
  }
}

/** True for the style every operator who never opened the setting has. */
export function isPlainStyle(style: QrStyle): boolean {
  return (
    style.modules === QR_STYLE_PLAIN.modules &&
    style.eyes === QR_STYLE_PLAIN.eyes &&
    style.dark === QR_STYLE_PLAIN.dark
  )
}

/** A dark colour a scanner can still separate from the white field — 7:1 or better. */
export function isUsableDark(hex: string): boolean {
  return HEX.test(hex) && relativeLuminance(hex) <= MAX_DARK_LUMINANCE
}

/**
 * The highest error-correction level that fits in the same symbol version as
 * `M`. Free margin: same size, same module pitch, more of the code recoverable.
 */
export function freeErrorCorrectionLevel(text: string): QRCodeErrorCorrectionLevel {
  const baseline = QRCode.create(text, { errorCorrectionLevel: 'M' }).version
  for (const level of ['H', 'Q'] as const) {
    if (QRCode.create(text, { errorCorrectionLevel: level }).version === baseline) return level
  }
  return 'M'
}

/**
 * The SVG markup for a code — the one entry point callers use.
 *
 * A plain style goes through `qrcode`'s own writer with `qrOptions()`: the same
 * bytes as every other unstyled code in this build. NOT the same bytes as the
 * released one — the same change that added styling also moved this path from a
 * raster to a vector and widened the quiet zone from one module to the four the
 * standard asks for, both argued in `qr-options.ts`. What the owner's rule
 * guarantees is narrower and exact: an operator who never opened the setting
 * never gets a STYLED code. Only a
 * styled one is drawn from the matrix here. The style must be handed in
 * EXPLICITLY by each call site: the connect sheet, read by the strictest
 * scanners there are, never receives one, and a renderer that looked the style
 * up for itself would style it without anyone deciding to.
 */
export async function qrSvg(text: string, style: QrStyle, displayPixels?: number): Promise<string> {
  if (isPlainStyle(style)) return QRCode.toString(text, qrOptions())
  return qrDrawingToSvg(drawQr(text, style, displayPixels === undefined ? {} : { displayPixels }))
}

export function drawQr(text: string, style: QrStyle, options: DrawQrOptions = {}): QrDrawing {
  const errorCorrectionLevel = freeErrorCorrectionLevel(text)
  const qr = QRCode.create(text, { errorCorrectionLevel })
  const matrix = qr.modules
  const n = matrix.size
  const q = QUIET_ZONE_MODULES
  const size = n + q * 2

  const pixelsPerModule =
    options.pixelsPerModule ??
    (options.displayPixels === undefined ? Number.POSITIVE_INFINITY : options.displayPixels / size)
  const moduleShape: QrModuleShape =
    style.modules === 'dots' && pixelsPerModule < MIN_PIXELS_PER_MODULE_FOR_DOTS
      ? 'rounded'
      : style.modules

  const inFinder = (row: number, col: number): boolean =>
    (row < 7 && col < 7) || (row < 7 && col >= n - 7) || (row >= n - 7 && col < 7)

  const shapes: QrShape[] = [{ kind: 'rect', x: 0, y: 0, w: size, h: size, r: 0, fill: LIGHT }]

  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (!matrix.get(row, col)) continue
      const reserved = matrix.isReserved(row, col) !== 0
      // Drawn whole below, as three nested rounded squares.
      if (reserved && style.eyes === 'rounded' && inFinder(row, col)) continue
      const x = col + q
      const y = row + q
      shapes.push(
        reserved
          ? { kind: 'rect', x, y, w: 1, h: 1, r: 0, fill: style.dark }
          : dataModule(moduleShape, x, y, style.dark),
      )
    }
  }

  if (style.eyes === 'rounded') {
    for (const [row, col] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      shapes.push(...roundedEye(col + q, row + q, style.dark))
    }
  }

  return { size, shapes, version: qr.version, errorCorrectionLevel }
}

export function qrDrawingToSvg(drawing: QrDrawing): string {
  const body = drawing.shapes.map(shapeToSvg).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.size} ${drawing.size}">${body}</svg>`
}

function dataModule(shape: QrModuleShape, x: number, y: number, fill: string): QrShape {
  if (shape === 'dots') return { kind: 'circle', cx: x + 0.5, cy: y + 0.5, r: DOT_RADIUS, fill }
  return { kind: 'rect', x, y, w: 1, h: 1, r: shape === 'rounded' ? ROUNDED_MODULE_RADIUS : 0, fill }
}

/**
 * A finder with rounded CORNERS only. Along the lines through its centre — the
 * ones the 1:1:3:1:1 test reads — the ring, the gap and the core keep their
 * exact widths: every radius is smaller than the distance from a corner to the
 * centre line.
 */
function roundedEye(x: number, y: number, fill: string): QrShape[] {
  return [
    { kind: 'rect', x, y, w: 7, h: 7, r: EYE_RADII.outer, fill },
    { kind: 'rect', x: x + 1, y: y + 1, w: 5, h: 5, r: EYE_RADII.hole, fill: LIGHT },
    { kind: 'rect', x: x + 2, y: y + 2, w: 3, h: 3, r: EYE_RADII.core, fill },
  ]
}

function shapeToSvg(shape: QrShape): string {
  const fill = escapeAttribute(shape.fill)
  if (shape.kind === 'circle') {
    return `<circle cx="${n3(shape.cx)}" cy="${n3(shape.cy)}" r="${n3(shape.r)}" fill="${fill}"/>`
  }
  const radius = shape.r > 0 ? ` rx="${n3(shape.r)}"` : ''
  return `<rect x="${n3(shape.x)}" y="${n3(shape.y)}" width="${n3(shape.w)}" height="${n3(shape.h)}"${radius} fill="${fill}"/>`
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** `#abc` → `#aabbcc`, lower-cased; anything that is not a hex colour → null. */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!HEX.test(trimmed)) return null
  if (trimmed.length === 4) {
    const [r, g, b] = [trimmed[1], trimmed[2], trimmed[3]]
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return trimmed
}

function n3(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** The colours reaching here are validated hex, but the SVG is markup: escape anyway. */
function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`)
}
