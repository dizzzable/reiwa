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
 *
 * The one exception is a code that carries a logo, which is the one thing that
 * actually SPENDS correction. Its level is the planner's (`qr-logo.ts`), which
 * weighs a larger knockout against smaller modules in CSS pixels.
 *
 * ── A logo ──────────────────────────────────────────────────────────────────
 *
 * `style.logo` names an image the operator uploaded; `qr-logo.ts` decides
 * whether it fits at the size the code is shown, and how large. A logo is drawn
 * ONLY when there is a plan AND the caller hands in the image, already loaded,
 * as a `data:` URI (`qr-logo-source.ts`). Without either, the code is exactly —
 * byte for byte — what the same style without a logo draws: while the image
 * loads, when it fails, at a size too small for one, on a link too dense for
 * one. A broken image in a code is never an outcome.
 *
 * What is drawn: the data modules of the planned knockout are left out; a
 * light plate is the white field itself, a dark plate is a rounded square in
 * the code's own dark colour, one module inside the knockout all round; the
 * image goes over everything, inside that. It goes in as a `data:` URI and
 * nothing else, because the SVG reaches the page as an `<img>`: an SVG used as
 * an image may not load external resources — MDN, "SVG as an image": scripts
 * are disabled, and outside images and stylesheets are refused unless inlined
 * as `data:` URLs. An `https:` logo would simply never paint. So the renderer
 * refuses every other href, and the loader is what turns an upload into one.
 *
 * The connect code never carries a logo. It never receives a style at all, and
 * a logo additionally needs the fourth argument of `qrSvg`, which `LocalQr` —
 * the component the connect sheet draws through — has no way to pass.
 *
 * ── How the shapes are written ──────────────────────────────────────────────
 *
 * Shapes that touch are ONE path. Written as separate elements — as they once
 * were, a `<rect>` per module — every edge two modules share was anti-aliased
 * twice: the pixel on it is covered half by each, and two half coverages
 * compound to 75%, not 100%. That drew a light grid through every styled code,
 * a quarter of the way to white, at every pixel density — measured in Chromium
 * at 1, 1.25, 1.5, 2 and 3 device pixels per CSS pixel — and a navy square
 * code at the partner's 256 px stopped decoding on 2× and 3× screens. Within
 * one path the rasteriser sums coverage over the whole outline, so a shared
 * edge is no edge at all.
 *
 * A group of touching shapes with no curve in it is drawn `crispEdges`, the
 * way `qrcode`'s own writer draws the plain code: square modules stay as sharp
 * as the unstyled code's, not fringed. A group with a curve in it — a rounded
 * module, and every square it touches — stays anti-aliased, because
 * `crispEdges` on a curve turns it into steps. So each run of one colour is at
 * most two paths, and nothing in one touches anything in the other. Dots stay
 * `<circle>` elements: they never touch, and callers tell dots from the
 * rounded squares they step down to by that element.
 */
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode'

import { QUIET_ZONE_MODULES, qrOptions, relativeLuminance } from './qr-options'
import { LOGO_MOAT_MODULES, type QrLogoPlan, knockoutIsClear, planQrLogo } from './qr-logo'

export type QrModuleShape = 'square' | 'rounded' | 'dots'
export type QrEyeShape = 'square' | 'rounded'
/** How wide a logo may grow: `small` ≤ 20% of the symbol, `large` ≤ 30% (`qr-logo.ts`). */
export type QrLogoSize = 'small' | 'large'
/** What the logo sits on: the white field itself, or a rounded square in the code's dark colour. */
export type QrLogoPlate = 'light' | 'dark'

export interface QrLogo {
  /**
   * The image: an upload the cabinet relays same-origin, `/uploads/branding/<file>`
   * with an image extension — and nothing else (`isQrLogoSrc`).
   */
  readonly src: string
  readonly size: QrLogoSize
  readonly plate: QrLogoPlate
}

export interface QrStyle {
  readonly modules: QrModuleShape
  readonly eyes: QrEyeShape
  /** The dark colour of modules and eyes. The field is always opaque white. */
  readonly dark: string
  /**
   * A logo in the middle, or `null` for none. Drawn only where it fits and only
   * once it has loaded — see the header.
   */
  readonly logo: QrLogo | null
}

export const QR_STYLE_PLAIN: QrStyle = { modules: 'square', eyes: 'square', dark: '#000000', logo: null }

const MODULE_SHAPES: readonly QrModuleShape[] = ['square', 'rounded', 'dots']
const EYE_SHAPES: readonly QrEyeShape[] = ['square', 'rounded']
const LOGO_SIZES: readonly QrLogoSize[] = ['small', 'large']
const LOGO_PLATES: readonly QrLogoPlate[] = ['light', 'dark']

const LIGHT = '#ffffff'
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * `/uploads/branding/<file>`, the file named as the cabinet's upload relay
 * accepts one (`isSafeBrandingFile` in `src/api/branding-pwa.ts`), with an
 * extension the relay serves an image type for — from its disk mirror the type
 * comes from the extension alone, and `application/octet-stream` is not
 * something the loader can draw.
 */
const LOGO_SRC = /^\/uploads\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|svg)$/i
const LOGO_SRC_MAX_LENGTH = 256

/** What the loader produces: a PNG it rasterised, or an SVG it inlined. Base64, so nothing in it needs escaping. */
const LOGO_HREF = /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/
/** Bounds the markup a logo can add to one code. The loader's own limits stay well under it. */
export const LOGO_HREF_MAX_LENGTH = 512 * 1024

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
 * A logo's floor is the same number (`LOGO_MIN_PIXELS_PER_MODULE`).
 */
export const MIN_PIXELS_PER_MODULE_FOR_DOTS = 4

/** Eye corner radii, in modules: outer ring (of 7), its white hole (of 5), the core (of 3). */
export const EYE_RADII = { outer: 1.6, hole: 1.1, core: 0.8 } as const

/**
 * A dark plate's corner radius, as a share of its width — an app icon's rounding.
 * Rounding does not change the lines through the plate's centre, and a plate
 * five modules wide inside the one-module moat can pass for a finder where the
 * link's modules complete it — see "What geometry cannot promise" in `qr-logo.ts`.
 */
export const LOGO_DARK_PLATE_RADIUS = 0.22
/** How far the image sits inside a dark plate, as a share of the plate's width, on every side. */
export const LOGO_DARK_PLATE_INSET = 0.15

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

/** Where the logo image is placed, in modules, and the image itself. */
export interface QrLogoImage {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** A `data:` URI, never anything that loads (`isQrLogoHref`). */
  readonly href: string
}

export interface QrDrawing {
  /** Modules across, quiet zone included. The SVG's viewBox is `0 0 size size`. */
  readonly size: number
  /** In paint order: later shapes cover earlier ones. */
  readonly shapes: readonly QrShape[]
  readonly version: number
  readonly errorCorrectionLevel: QRCodeErrorCorrectionLevel
  /** The logo image, painted over every shape. Absent whenever no logo is drawn. */
  readonly logo?: QrLogoImage
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
  /**
   * A logo to draw: `planQrLogo`'s plan for this text and style, and the loaded
   * image. Ignored — the code drawn as if it were absent — when the style has
   * no logo, the href is not a `data:` image, or the plan does not fit this
   * text's matrix (another text's plan could otherwise clear a finder).
   */
  readonly logo?: { readonly plan: QrLogoPlan; readonly href: string }
}

/**
 * Any input → a style that is safe to draw. Never throws: this is read from a
 * branding payload, and the cabinet's snapshot guard throws the WHOLE brand away
 * on the first reader that refuses — so refusing belongs to the panel, where
 * there is an operator to tell, and this answers every input with a valid style.
 * `Object.hasOwn`, because `raw['constructor']` on a plain object is a function
 * inherited from the prototype, not a missing key.
 *
 * The logo is all or nothing, unlike the members above: a logo whose size or
 * plate this build does not know, or whose source is anything but a relayed
 * upload, is no logo — a panel older than the member sends no `logo` key, and
 * that is no logo too.
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
    logo: resolveQrLogo(own('logo')),
  }
}

/**
 * True for the style every operator who never opened the setting has: square
 * modules and eyes, black, and NO logo.
 *
 * A style with a logo is not plain, even when every other member is — the
 * panel's reset control reads this. It can still DRAW as the plain code: when
 * no logo is drawn (none fits at the size shown, or the image has not loaded),
 * `qrSvg` draws exactly what the same style without a logo draws, and for
 * plain members that is `qrcode`'s own writer.
 */
export function isPlainStyle(style: QrStyle): boolean {
  return (
    style.modules === QR_STYLE_PLAIN.modules &&
    style.eyes === QR_STYLE_PLAIN.eyes &&
    style.dark === QR_STYLE_PLAIN.dark &&
    style.logo === null
  )
}

/** A dark colour a scanner can still separate from the white field — 7:1 or better. */
export function isUsableDark(hex: string): boolean {
  return HEX.test(hex) && relativeLuminance(hex) <= MAX_DARK_LUMINANCE
}

/** A logo source this build will load: a relayed upload, `/uploads/branding/<file>`, and nothing else. */
export function isQrLogoSrc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= LOGO_SRC_MAX_LENGTH &&
    LOGO_SRC.test(value) &&
    !value.includes('..')
  )
}

/** An image href this renderer will write into a code: a base64 PNG or SVG `data:` URI of bounded size. */
export function isQrLogoHref(value: unknown): value is string {
  return typeof value === 'string' && value.length <= LOGO_HREF_MAX_LENGTH && LOGO_HREF.test(value)
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
 *
 * `logoHref` is the style's logo, loaded (`loadQrLogo`). A logo is drawn when
 * it is a `data:` image AND `planQrLogo` has a plan for `displayPixels`; in
 * every other case — no href yet, a failed load, no plan — the result is
 * byte for byte the same style with `logo: null`.
 */
export async function qrSvg(
  text: string,
  style: QrStyle,
  displayPixels?: number,
  logoHref?: string,
): Promise<string> {
  const plan =
    displayPixels !== undefined && isQrLogoHref(logoHref) ? planQrLogo(text, style, displayPixels) : null
  if (plan !== null && logoHref !== undefined) {
    return qrDrawingToSvg(drawQr(text, style, { displayPixels, logo: { plan, href: logoHref } }))
  }

  const withoutLogo: QrStyle = style.logo === null ? style : { ...style, logo: null }
  if (isPlainStyle(withoutLogo)) return QRCode.toString(text, qrOptions())
  return qrDrawingToSvg(drawQr(text, withoutLogo, displayPixels === undefined ? {} : { displayPixels }))
}

export function drawQr(text: string, style: QrStyle, options: DrawQrOptions = {}): QrDrawing {
  const requested = options.logo
  const logo =
    requested !== undefined && style.logo !== null && isQrLogoHref(requested.href) ? requested : undefined
  const errorCorrectionLevel = logo === undefined ? freeErrorCorrectionLevel(text) : logo.plan.level
  const qr = QRCode.create(text, { errorCorrectionLevel })
  const matrix = qr.modules
  const n = matrix.size
  if (logo !== undefined && (logo.plan.modules !== n || !knockoutIsClear(matrix, logo.plan.knockout))) {
    // A plan made for another text, level or version. Whatever it would clear
    // here is not known to be data, so draw the code as if no logo were asked for.
    return drawQr(text, style, { ...options, logo: undefined })
  }
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

  const knockout = logo === undefined ? 0 : logo.plan.knockout
  const knockoutFrom = (n - knockout) / 2
  const inKnockout = (row: number, col: number): boolean =>
    knockout > 0 &&
    row >= knockoutFrom &&
    row < knockoutFrom + knockout &&
    col >= knockoutFrom &&
    col < knockoutFrom + knockout

  const shapes: QrShape[] = [{ kind: 'rect', x: 0, y: 0, w: size, h: size, r: 0, fill: LIGHT }]

  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (!matrix.get(row, col)) continue
      // Under the logo. Only data modules are ever here: `knockoutIsClear` above.
      if (inKnockout(row, col)) continue
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

  if (logo === undefined || style.logo === null) {
    return { size, shapes, version: qr.version, errorCorrectionLevel }
  }

  // The plate: inside the knockout, clear of it by the moat on every side.
  const plateFrom = q + knockoutFrom + LOGO_MOAT_MODULES
  const plateWidth = knockout - LOGO_MOAT_MODULES * 2
  let image: QrLogoImage = { x: plateFrom, y: plateFrom, w: plateWidth, h: plateWidth, href: logo.href }
  if (style.logo.plate === 'dark') {
    shapes.push({
      kind: 'rect',
      x: plateFrom,
      y: plateFrom,
      w: plateWidth,
      h: plateWidth,
      r: plateWidth * LOGO_DARK_PLATE_RADIUS,
      fill: style.dark,
    })
    const inset = plateWidth * LOGO_DARK_PLATE_INSET
    image = {
      x: plateFrom + inset,
      y: plateFrom + inset,
      w: plateWidth - inset * 2,
      h: plateWidth - inset * 2,
      href: logo.href,
    }
  }
  // A light plate is the white field itself, which the knockout leaves bare.
  return { size, shapes, version: qr.version, errorCorrectionLevel, logo: image }
}

/**
 * The drawing as SVG markup, painted in the drawing's order — see "How the
 * shapes are written" in the header for why touching shapes share a path.
 *
 * Shapes are taken in runs of one colour. Inside a run the order of painting
 * cannot change a pixel (one colour over itself is the same colour whichever
 * goes first), so a run may be regrouped freely; between runs the order is
 * kept, which is what puts a rounded eye's white hole over its ring.
 */
export function qrDrawingToSvg(drawing: QrDrawing): string {
  const body = runsOfOneColour(drawing.shapes).map(runToSvg).join('')
  const logo = drawing.logo !== undefined && isQrLogoHref(drawing.logo.href) ? imageToSvg(drawing.logo) : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.size} ${drawing.size}">${body}${logo}</svg>`
}

type QrRect = Extract<QrShape, { kind: 'rect' }>
type QrCircle = Extract<QrShape, { kind: 'circle' }>

function runsOfOneColour(shapes: readonly QrShape[]): QrShape[][] {
  const runs: QrShape[][] = []
  for (const shape of shapes) {
    const run = runs[runs.length - 1]
    if (run !== undefined && run[0]?.fill === shape.fill) run.push(shape)
    else runs.push([shape])
  }
  return runs
}

/**
 * A run of one colour: at most one crisp path, one anti-aliased path, and the
 * circles. A rect goes to the anti-aliased path when anything it touches, or
 * anything touching that, has a curve — so no rect in one path touches a rect
 * in the other.
 */
function runToSvg(run: readonly QrShape[]): string {
  const rects = run.filter((shape): shape is QrRect => shape.kind === 'rect')
  const circles = run.filter((shape): shape is QrCircle => shape.kind === 'circle')
  const smooth = rectsTouchingACurve(rects)
  const fill = escapeAttribute(run[0]?.fill ?? '')
  const sharp = joinRowNeighbours(rects.filter((_, i) => !smooth[i]))
  const curved = rects.filter((_, i) => smooth[i])
  return (
    (sharp.length > 0 ? `<path fill="${fill}" shape-rendering="crispEdges" d="${sharp.map(rectPath).join('')}"/>` : '') +
    (curved.length > 0 ? `<path fill="${fill}" d="${curved.map(rectPath).join('')}"/>` : '') +
    circles.map(circleToSvg).join('')
  )
}

const isCurved = (rect: QrRect): boolean => rect.r > 0 && rect.w > 0 && rect.h > 0

/**
 * For each rect: does its group of touching rects — touching counted
 * transitively — contain a curve? Union-find over the touching pairs. A module
 * is a unit square on whole coordinates, so modules find their neighbours by
 * cell; the few other rects (eyes, a plate) are tested against every rect.
 */
function rectsTouchingACurve(rects: readonly QrRect[]): boolean[] {
  const parent = rects.map((_, i) => i)
  const root = (i: number): number => {
    let at = i
    while (parent[at] !== at) {
      const up = parent[parent[at] as number] as number
      parent[at] = up
      at = up
    }
    return at
  }
  const join = (a: number, b: number): void => {
    parent[root(a)] = root(b)
  }

  const cells = new Map<string, number>()
  const others: number[] = []
  rects.forEach((rect, i) => {
    if (rect.w === 1 && rect.h === 1 && Number.isInteger(rect.x) && Number.isInteger(rect.y)) {
      const key = `${rect.x},${rect.y}`
      const twin = cells.get(key)
      if (twin !== undefined) join(i, twin)
      else cells.set(key, i)
    } else {
      others.push(i)
    }
  })
  for (const i of cells.values()) {
    const { x, y } = rects[i] as QrRect
    for (const key of [`${x + 1},${y}`, `${x},${y + 1}`]) {
      const neighbour = cells.get(key)
      if (neighbour !== undefined) join(i, neighbour)
    }
  }
  for (const i of others) {
    rects.forEach((rect, j) => {
      if (j !== i && rectsTouch(rects[i] as QrRect, rect)) join(i, j)
    })
  }

  const curvedRoot = new Set<number>()
  rects.forEach((rect, i) => {
    if (isCurved(rect)) curvedRoot.add(root(i))
  })
  return rects.map((_, i) => curvedRoot.has(root(i)))
}

/** Boxes that overlap, or share an edge of some length — a shared corner is not touching. */
function rectsTouch(a: QrRect, b: QrRect): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return overlapX >= 0 && overlapY >= 0 && overlapX + overlapY > 0
}

/** Sharp rects side by side in one row, as one rect: the same area in far fewer bytes. */
function joinRowNeighbours(rects: readonly QrRect[]): QrRect[] {
  const joined: QrRect[] = []
  for (const rect of rects) {
    const last = joined[joined.length - 1]
    if (last !== undefined && last.y === rect.y && last.h === rect.h && last.x + last.w === rect.x) {
      joined[joined.length - 1] = { ...last, w: last.w + rect.w }
    } else {
      joined.push(rect)
    }
  }
  return joined
}

/**
 * One rect as one clockwise subpath — clockwise for every rect, so where two
 * meet their shared edge cancels out under the nonzero rule. A rounded one
 * takes the corner radii `rx` gives a `<rect>`: `rx` for both axes, each
 * clamped to half its side.
 */
function rectPath(rect: QrRect): string {
  const rx = Math.max(0, Math.min(rect.r, rect.w / 2))
  const ry = Math.max(0, Math.min(rect.r, rect.h / 2))
  if (rx === 0 || ry === 0) {
    return `M${pathNumbers(rect.x, rect.y)}h${pathNumbers(rect.w)}v${pathNumbers(rect.h)}h${pathNumbers(-rect.w)}z`
  }
  const acrossX = rect.w - 2 * rx
  const acrossY = rect.h - 2 * ry
  const corner = (dx: number, dy: number): string => `a${pathNumbers(rx, ry)} 0 0 1 ${pathNumbers(dx, dy)}`
  return (
    `M${pathNumbers(rect.x + rx, rect.y)}` +
    (acrossX > 0 ? `h${pathNumbers(acrossX)}` : '') +
    corner(rx, ry) +
    (acrossY > 0 ? `v${pathNumbers(acrossY)}` : '') +
    corner(-rx, ry) +
    (acrossX > 0 ? `h${pathNumbers(-acrossX)}` : '') +
    corner(-rx, -ry) +
    (acrossY > 0 ? `v${pathNumbers(-acrossY)}` : '') +
    corner(rx, -ry) +
    'z'
  )
}

/**
 * Numbers as path data takes them, in few bytes — the markup reaches the page
 * percent-encoded, where a space costs three. At most three decimals, no
 * leading zero, and a separator only where the grammar needs one: never
 * before a minus sign, never between `.3` and `.3` (a number has one point).
 * Arc flags are spelled out with spaces around them by the caller: a parser
 * that took `1.3` for a number instead of a flag and `.3` would draw nonsense.
 */
function pathNumbers(...values: number[]): string {
  let text = ''
  let previous = ''
  for (const value of values) {
    const next = n3(value).replace(/^(-?)0\./, '$1.')
    const joins = next.startsWith('-') || (next.startsWith('.') && previous.includes('.'))
    text += previous === '' || joins ? next : ` ${next}`
    previous = next
  }
  return text
}

function circleToSvg(circle: QrCircle): string {
  return `<circle cx="${n3(circle.cx)}" cy="${n3(circle.cy)}" r="${n3(circle.r)}" fill="${escapeAttribute(circle.fill)}"/>`
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

/**
 * The logo, over everything. `preserveAspectRatio` is left at its default,
 * `xMidYMid meet`: the whole image, centred, never cropped or stretched.
 */
function imageToSvg(image: QrLogoImage): string {
  return `<image href="${escapeAttribute(image.href)}" x="${n3(image.x)}" y="${n3(image.y)}" width="${n3(image.w)}" height="${n3(image.h)}"/>`
}

function resolveQrLogo(raw: unknown): QrLogo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const own = (key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined)
  const src = own('src')
  const size = own('size')
  const plate = own('plate')
  if (!isQrLogoSrc(src)) return null
  if (typeof size !== 'string' || !(LOGO_SIZES as readonly string[]).includes(size)) return null
  if (typeof plate !== 'string' || !(LOGO_PLATES as readonly string[]).includes(plate)) return null
  return { src, size: size as QrLogoSize, plate: plate as QrLogoPlate }
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
