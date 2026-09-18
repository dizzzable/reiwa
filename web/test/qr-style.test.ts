/**
 * The styled-QR core, structurally: what a style may contain, what styling must
 * never touch, and what reaches the SVG writer.
 *
 * Whether a styled code still READS is proven separately, by decoding it
 * (`qr-style-decodes.test.ts`). The claims here are the ones a decoder cannot
 * see clearly enough to blame: that function patterns are left alone, that the
 * lines through a finder keep their 1:1:3:1:1 widths, that no dark ink reaches
 * the quiet zone, and that an operator's colour is refused when a scanner could
 * not separate it from white.
 */
import { createHash } from 'node:crypto'

import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

import { planQrLogo } from '@/lib/qr-logo'
import { QUIET_ZONE_MODULES, qrOptions, relativeLuminance } from '@/lib/qr-options'
import {
  LOGO_DARK_PLATE_INSET,
  LOGO_DARK_PLATE_RADIUS,
  LOGO_HREF_MAX_LENGTH,
  MAX_DARK_LUMINANCE,
  MIN_PIXELS_PER_MODULE_FOR_DOTS,
  QR_STYLE_PLAIN,
  type QrDrawing,
  type QrLogoPlate,
  type QrLogoSize,
  type QrStyle,
  drawQr,
  freeErrorCorrectionLevel,
  isPlainStyle,
  isQrLogoHref,
  isQrLogoSrc,
  isUsableDark,
  qrDrawingToSvg,
  qrSvg,
  resolveQrStyle,
} from '@/lib/qr-style'

import { paintAt } from './support/qr-raster'

const LINK = 'https://cabinet.example.com/r/abc123'

describe('resolveQrStyle', () => {
  it('answers plain for anything that is not a style', () => {
    for (const raw of [undefined, null, 'rounded', 42, [], true]) {
      expect(resolveQrStyle(raw)).toEqual(QR_STYLE_PLAIN)
    }
  })

  it('keeps the shapes and the colour an operator chose', () => {
    expect(resolveQrStyle({ modules: 'dots', eyes: 'rounded', dark: '#1E3A8A' })).toEqual({
      modules: 'dots',
      eyes: 'rounded',
      dark: '#1e3a8a',
      logo: null,
    })
  })

  it('falls back field by field, not for the whole style', () => {
    expect(resolveQrStyle({ modules: 'hearts', eyes: 'rounded' })).toEqual({
      ...QR_STYLE_PLAIN,
      eyes: 'rounded',
    })
  })

  it('refuses a dark colour a scanner cannot separate from white, and draws black instead', () => {
    // The near-white the referral code once shipped with; a bright brand
    // yellow; the classic 4.5:1 text grey, which the camera model showed does
    // NOT carry a dense code; a colour carrying alpha; and a colour name.
    for (const dark of ['#fafafa', '#ffcc00', '#767676', '#00000080', 'navy']) {
      expect(resolveQrStyle({ dark }).dark, dark).toBe('#000000')
    }
  })

  it('expands the three-digit form so equal colours compare equal', () => {
    expect(resolveQrStyle({ dark: '#123' }).dark).toBe('#112233')
  })

  it('reads only its own keys, never the prototype', () => {
    const inherited = Object.create({ modules: 'dots', dark: '#1e3a8a' }) as object
    expect(resolveQrStyle(inherited)).toEqual(QR_STYLE_PLAIN)
    expect(resolveQrStyle({ constructor: 'dots' })).toEqual(QR_STYLE_PLAIN)
  })
})

describe('isUsableDark', () => {
  it('draws the line at 7:1 against white, checked on both sides of it', () => {
    // #595959 is 7.00:1, #5a5a5a is 6.90:1. Not WCAG's 4.5:1 for text: the
    // 4.5:1 grey #767676 failed the camera-model decode on the subscription
    // link, and that measurement is why the floor sits here.
    expect(relativeLuminance('#595959')).toBeLessThanOrEqual(MAX_DARK_LUMINANCE)
    expect(isUsableDark('#595959')).toBe(true)
    expect(isUsableDark('#5a5a5a')).toBe(false)
    expect(isUsableDark('#767676')).toBe(false)
    expect(isUsableDark('#000000')).toBe(true)
    // The brand navy used across these tests, at 10.4:1.
    expect(isUsableDark('#1e3a8a')).toBe(true)
  })
})

describe('isPlainStyle', () => {
  it('is true for the style of an operator who never opened the setting', () => {
    expect(isPlainStyle(QR_STYLE_PLAIN)).toBe(true)
    expect(isPlainStyle(resolveQrStyle({}))).toBe(true)
    expect(isPlainStyle(resolveQrStyle(undefined))).toBe(true)
  })

  it('is false the moment any one field differs', () => {
    expect(isPlainStyle({ ...QR_STYLE_PLAIN, modules: 'rounded' })).toBe(false)
    expect(isPlainStyle({ ...QR_STYLE_PLAIN, eyes: 'rounded' })).toBe(false)
    expect(isPlainStyle({ ...QR_STYLE_PLAIN, dark: '#1e3a8a' })).toBe(false)
  })
})

describe('freeErrorCorrectionLevel', () => {
  it('never changes the symbol version it was given', () => {
    // The whole point: more correction at the SAME size. A version bump would
    // shrink every module, which is what actually costs camera reads.
    for (const text of [LINK, 'https://t.me/x', 'a'.repeat(60), 'https://example.com/' + 'x'.repeat(120)]) {
      const baseline = QRCode.create(text, { errorCorrectionLevel: 'M' }).version
      const chosen = QRCode.create(text, {
        errorCorrectionLevel: freeErrorCorrectionLevel(text),
      }).version
      expect(chosen, text).toBe(baseline)
    }
  })

  it('does find a free upgrade when one exists', () => {
    // 20 bytes sit in version 2 at M (26) and at Q (20), not at H (14). A
    // function that always answered M would pass the case above and fail this.
    const text = 'https://t.me/ab12345'
    expect(text).toHaveLength(20)
    expect(freeErrorCorrectionLevel(text)).toBe('Q')

    // And the HIGHEST free level, not merely the first one that fits. Seven
    // bytes sit in version 1 at every level, H included — the only shape of
    // payload for which H is ever free, which is why nothing else here reaches
    // that branch at all: a search that tried Q before H would answer Q for
    // every input in this file and fail nothing.
    expect(freeErrorCorrectionLevel('abcdefg')).toBe('H')
  })
})

describe('drawQr', () => {
  const styled = (over: Partial<QrStyle>): QrStyle => ({ ...QR_STYLE_PLAIN, ...over })
  const matrixOf = (drawing: QrDrawing) =>
    QRCode.create(LINK, { errorCorrectionLevel: drawing.errorCorrectionLevel }).modules
  /** `x,y` of every dark shape drawn, for a style whose modules are all rects. */
  const darkModules = (drawing: QrDrawing): string[] =>
    drawing.shapes
      .slice(1)
      .map((shape) => (shape.kind === 'rect' ? `${shape.x},${shape.y}` : `circle ${shape.cx},${shape.cy}`))
      .sort()
  /** The same, read straight out of the encoder at a level named here. */
  const matrixModules = (text: string, level: 'M' | 'Q'): string[] => {
    const matrix = QRCode.create(text, { errorCorrectionLevel: level }).modules
    const out: string[] = []
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        if (matrix.get(row, col)) out.push(`${col + QUIET_ZONE_MODULES},${row + QUIET_ZONE_MODULES}`)
      }
    }
    return out.sort()
  }

  it('lays an opaque white field under everything, quiet zone included', () => {
    const drawing = drawQr(LINK, styled({ modules: 'dots' }))
    expect(drawing.shapes[0]).toEqual({
      kind: 'rect',
      x: 0,
      y: 0,
      w: drawing.size,
      h: drawing.size,
      r: 0,
      fill: '#ffffff',
    })
  })

  it('draws every function module as a solid square, whatever the module style', () => {
    const drawing = drawQr(LINK, styled({ modules: 'dots', dark: '#1e3a8a' }))
    const matrix = matrixOf(drawing)
    const q = QUIET_ZONE_MODULES
    const solid = new Set(
      drawing.shapes
        .filter((s) => s.kind === 'rect' && s.w === 1 && s.h === 1 && s.r === 0)
        .map((s) => (s.kind === 'rect' ? `${s.x},${s.y}` : '')),
    )
    let reservedDark = 0
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        if (!matrix.get(row, col) || matrix.isReserved(row, col) === 0) continue
        reservedDark += 1
        expect(solid.has(`${col + q},${row + q}`), `function module ${row},${col}`).toBe(true)
      }
    }
    expect(reservedDark).toBeGreaterThan(100)
  })

  it('styles the data modules, and only those', () => {
    const drawing = drawQr(LINK, styled({ modules: 'dots' }))
    const matrix = matrixOf(drawing)
    let dataDark = 0
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        if (matrix.get(row, col) && matrix.isReserved(row, col) === 0) dataDark += 1
      }
    }
    expect(drawing.shapes.filter((s) => s.kind === 'circle')).toHaveLength(dataDark)
  })

  it('keeps every drop of dark ink out of the quiet zone', () => {
    for (const style of [styled({ modules: 'dots' }), styled({ modules: 'rounded', eyes: 'rounded' })]) {
      const drawing = drawQr(LINK, style)
      const low = QUIET_ZONE_MODULES
      const high = drawing.size - QUIET_ZONE_MODULES
      for (const shape of drawing.shapes.slice(1)) {
        if (shape.fill !== style.dark) continue
        const [x0, y0, x1, y1] =
          shape.kind === 'circle'
            ? [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r]
            : [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
        expect(x0 >= low && y0 >= low && x1 <= high && y1 <= high, JSON.stringify(shape)).toBe(true)
      }
    }
  })

  it('keeps 1:1:3:1:1 along the lines through every finder, rounded or not', () => {
    // The run-length test a decoder uses to FIND the symbol. Rounded eyes may
    // only touch the corners; the centre row and column must keep their exact
    // widths. Sampled at quarter-module steps, so 1:1:3:1:1 reads 4:4:12:4:4.
    for (const eyes of ['square', 'rounded'] as const) {
      const style = styled({ eyes, dark: '#1e3a8a' })
      const drawing = drawQr(LINK, style)
      const n = drawing.size - QUIET_ZONE_MODULES * 2
      const q = QUIET_ZONE_MODULES
      for (const [row, col] of [
        [0, 0],
        [0, n - 7],
        [n - 7, 0],
      ] as const) {
        const x0 = col + q
        const y0 = row + q
        const runs = (sample: (t: number) => string | null): number[] => {
          const dark: boolean[] = []
          for (let i = 0; i < 28; i += 1) dark.push(sample(i / 4 + 0.125) === style.dark)
          const out: number[] = []
          let current = dark[0]
          let length = 0
          for (const d of dark) {
            if (d === current) length += 1
            else {
              out.push(length)
              current = d
              length = 1
            }
          }
          out.push(length)
          return out
        }
        const across = runs((t) => paintAt(drawing, x0 + t, y0 + 3.5))
        const down = runs((t) => paintAt(drawing, x0 + 3.5, y0 + t))
        expect(across, `${eyes} eye at ${row},${col}, across`).toEqual([4, 4, 12, 4, 4])
        expect(down, `${eyes} eye at ${row},${col}, down`).toEqual([4, 4, 12, 4, 4])
      }
    }
  })

  it('rounds the CORNERS of a rounded eye — which is the whole of what the setting buys', () => {
    // The 1:1:3:1:1 case above asserts the SAME widths for a square eye and a
    // rounded one, deliberately: rounding must not touch the centre lines. So
    // nothing looked at a corner, and a renderer that drew the finder's
    // modules as solid squares and then laid the rounded eye OVER them —
    // square corners, still perfectly decodable, the operator's choice
    // silently reverted — passed every case in this file and every decode.
    const inset = 0.15
    for (const eyes of ['square', 'rounded'] as const) {
      const style = styled({ eyes, dark: '#1e3a8a' })
      const drawing = drawQr(LINK, style)
      const n = drawing.size - QUIET_ZONE_MODULES * 2
      const q = QUIET_ZONE_MODULES
      for (const [row, col] of [
        [0, 0],
        [0, n - 7],
        [n - 7, 0],
      ] as const) {
        for (const [dx, dy] of [
          [inset, inset],
          [7 - inset, inset],
          [inset, 7 - inset],
          [7 - inset, 7 - inset],
        ] as const) {
          const painted = paintAt(drawing, col + q + dx, row + q + dy)
          expect(
            painted === style.dark,
            `${eyes} eye at ${row},${col}: the corner ${inset} in at ${dx},${dy} is ${String(painted)}`,
          ).toBe(eyes === 'square')
        }
      }
    }
  })

  it('encodes at the free error-correction level, not at `M`', () => {
    // The seam. `freeErrorCorrectionLevel` is proven on its own above, and
    // every other case in this file reads the level back OFF the drawing — so
    // a renderer that went on encoding at `M` draws a code that looks
    // identical, carries less correction at the same size, and agrees with
    // itself everywhere.
    const text = 'https://t.me/ab12345'
    expect(freeErrorCorrectionLevel(text), 'precondition: this link has a free upgrade').toBe('Q')

    const drawing = drawQr(text, styled({ modules: 'rounded' }))
    expect(drawing.errorCorrectionLevel).toBe('Q')
    // …and the level reached the ENCODER, not just the reported field: the
    // same symbol version at Q and at M lays its modules out differently.
    expect(darkModules(drawing)).toEqual(matrixModules(text, 'Q'))
    expect(darkModules(drawing)).not.toEqual(matrixModules(text, 'M'))
  })

  it('turns dots into rounded squares when the code is drawn small', () => {
    const dots = styled({ modules: 'dots' })
    const small = drawQr(LINK, dots, { pixelsPerModule: MIN_PIXELS_PER_MODULE_FOR_DOTS - 1 })
    const large = drawQr(LINK, dots, { pixelsPerModule: MIN_PIXELS_PER_MODULE_FOR_DOTS + 2 })
    expect(small.shapes.some((s) => s.kind === 'circle')).toBe(false)
    expect(large.shapes.some((s) => s.kind === 'circle')).toBe(true)
  })
})

/* ─────────────────────────── reading the SVG back ─────────────────────────── */

interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/** One painted outline, read back out of the markup. */
interface Piece {
  /** Which element, in document order: pieces of one `<path>` share it. */
  readonly element: number
  readonly tag: 'path' | 'circle' | 'rect'
  readonly fill: string
  readonly crisp: boolean
  readonly box: Box
  /** A subpath with corner arcs, or a circle. */
  readonly curved: boolean
  /** A subpath's corner radii; a circle's radius twice. */
  readonly rx: number
  readonly ry: number
  /** A circle's centre, as written. */
  readonly centre?: string
}

/** Relative path arithmetic lands on 13.000000000000002; the writer never means that. */
const snap = (value: number): number => Math.round(value * 1e9) / 1e9

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1]

/**
 * Path data as the SVG grammar reads it: a number may drop its leading zero,
 * and needs no separator before a minus sign, or before a point when the one
 * ahead of it already has one. Written independently of the renderer, so a
 * writer that leaves out a separator the grammar needs reads back as the wrong
 * geometry, and the fidelity case below fails on it.
 */
function subpathsOf(d: string): Array<{ box: Box; curved: boolean; rx: number; ry: number }> {
  const tokens = d.match(/[MmHhVvAaZz]|-?(?:\d+\.?\d*|\.\d+)/g) ?? []
  expect(tokens.join(''), `path data has characters the grammar does not read: ${d}`).toBe(d.replace(/[\s,]/g, ''))
  const out: Array<{ box: Box; curved: boolean; rx: number; ry: number }> = []
  let at = 0
  let x = 0
  let y = 0
  let points: Array<[number, number]> = []
  let curved = false
  let radii: [number, number] = [0, 0]
  const next = (): number => {
    const token = tokens[at++]
    if (token === undefined || /[A-Za-z]/.test(token)) throw new Error(`a number was expected in ${d}`)
    return Number(token)
  }
  while (at < tokens.length) {
    const command = tokens[at++]
    if (command === 'M') {
      x = next()
      y = next()
      points = [[x, y]]
      curved = false
    } else if (command === 'h') {
      x = snap(x + next())
      points.push([x, y])
    } else if (command === 'v') {
      y = snap(y + next())
      points.push([x, y])
    } else if (command === 'a') {
      const rx = next()
      const ry = next()
      const [rotation, large, sweep] = [next(), next(), next()]
      // A convex corner, drawn clockwise: anything else is not the corner of a rect.
      expect([rotation, large, sweep], `an arc that is not a rect's corner in ${d}`).toEqual([0, 0, 1])
      x = snap(x + next())
      y = snap(y + next())
      points.push([x, y])
      curved = true
      radii = [rx, ry]
    } else if (command === 'z') {
      const xs = points.map(([px]) => px)
      const ys = points.map(([, py]) => py)
      out.push({
        box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) },
        curved,
        rx: curved ? radii[0] : 0,
        ry: curved ? radii[1] : 0,
      })
    } else {
      throw new Error(`the writer is not expected to use "${command}": ${d}`)
    }
  }
  return out
}

function piecesOf(svg: string): Piece[] {
  const pieces: Piece[] = []
  let element = 0
  for (const [, tag, attributes = ''] of svg.matchAll(/<(path|circle|rect|image)\b([^>]*)\/>/g)) {
    if (tag === 'image') continue
    const fill = attribute(attributes, 'fill') ?? ''
    const crisp = attribute(attributes, 'shape-rendering') === 'crispEdges'
    if (tag === 'path') {
      for (const sub of subpathsOf(attribute(attributes, 'd') ?? '')) {
        pieces.push({ element, tag, fill, crisp, ...sub })
      }
    } else if (tag === 'circle') {
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((name) => Number(attribute(attributes, name))) as [number, number, number]
      const box = { x0: snap(cx - r), y0: snap(cy - r), x1: snap(cx + r), y1: snap(cy + r) }
      pieces.push({ element, tag, fill, crisp, box, curved: true, rx: r, ry: r, centre: `${cx},${cy}` })
    } else {
      const [px, py, w, h] = ['x', 'y', 'width', 'height'].map((name) => Number(attribute(attributes, name) ?? 0))
      const r = Number(attribute(attributes, 'rx') ?? 0)
      pieces.push({ element, tag: 'rect', fill, crisp, box: { x0: px, y0: py, x1: px + w, y1: py + h }, curved: r > 0, rx: r, ry: r })
    }
    element += 1
  }
  return pieces
}

/** Overlap, or an edge of some length in common — the shared corner of two diagonal modules is not touching. */
function touches(a: Box, b: Box): boolean {
  const x = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const y = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return x >= 0 && y >= 0 && x + y > 0
}

/** Consecutive things of one colour: what is painted over each other with nothing between. */
function colourRuns<T extends { readonly fill: string }>(items: readonly T[]): T[][] {
  const runs: T[][] = []
  for (const item of items) {
    const run = runs[runs.length - 1]
    if (run !== undefined && run[0]?.fill === item.fill) run.push(item)
    else runs.push([item])
  }
  return runs
}

/** Every styling the renderer draws, at the sizes the cabinet shows codes at. */
const WRITER_CASES: ReadonlyArray<readonly [string, QrStyle, number | undefined]> = [
  ['square modules in a colour', { ...QR_STYLE_PLAIN, dark: '#1e3a8a' }, 208],
  ['square modules, rounded eyes', { ...QR_STYLE_PLAIN, eyes: 'rounded', dark: '#1e3a8a' }, 208],
  ['rounded modules and eyes', { modules: 'rounded', eyes: 'rounded', dark: '#1e3a8a', logo: null }, 256],
  ['rounded modules, square eyes', { ...QR_STYLE_PLAIN, modules: 'rounded' }, 208],
  ['dots, square eyes', { ...QR_STYLE_PLAIN, modules: 'dots' }, 208],
  ['dots stepped down to rounded squares', { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }, 96],
  ['dots with no size given', { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }, undefined],
  [
    'rounded, with a logo on a dark plate',
    {
      modules: 'rounded',
      eyes: 'rounded',
      dark: '#1e3a8a',
      logo: { src: '/uploads/branding/brand-mark.png', size: 'large', plate: 'dark' },
    },
    208,
  ],
]

/** The drawing a caller gets — with its logo drawn, where the style has one. */
function drawnFor(style: QrStyle, px: number | undefined): QrDrawing {
  if (style.logo === null || px === undefined) return drawQr(REFERRAL_66, style, px === undefined ? {} : { displayPixels: px })
  const plan = planQrLogo(REFERRAL_66, style, px)
  if (plan === null) throw new Error('precondition: the planner has room for this logo')
  return drawQr(REFERRAL_66, style, { displayPixels: px, logo: { plan, href: PNG_HREF } })
}

describe('qrDrawingToSvg', () => {
  it('writes the drawing inside its own viewBox', () => {
    const drawing = drawQr(LINK, { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null })
    expect(qrDrawingToSvg(drawing)).toContain(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.size} ${drawing.size}">`)
  })

  /**
   * THE GUARD FOR THE SEAMS. Two anti-aliased elements that share an edge each
   * cover the pixel on it only in part, and the parts compound instead of
   * adding up: a light grid through every styled code, a quarter of the way to
   * white, measured in Chromium at every pixel density — and a navy square code
   * at 256 px that no longer decoded on 2× and 3× screens. So whatever of one
   * colour is painted in one go must be ONE element wherever it touches.
   */
  it.each(WRITER_CASES)('never lets two elements of one colour share an edge — %s', (_name, style, px) => {
    const pieces = piecesOf(qrDrawingToSvg(drawnFor(style, px)))
    // No module is its own <rect> any more: a rect element per module is the seam.
    expect(pieces.filter((piece) => piece.tag === 'rect')).toEqual([])
    const shared: string[] = []
    for (const run of colourRuns(pieces)) {
      for (let i = 0; i < run.length; i += 1) {
        for (let j = i + 1; j < run.length; j += 1) {
          const [a, b] = [run[i] as Piece, run[j] as Piece]
          if (a.element !== b.element && touches(a.box, b.box)) {
            shared.push(`${a.tag}#${a.element} and ${b.tag}#${b.element} at ${a.box.x0},${a.box.y0} / ${b.box.x0},${b.box.y0}`)
          }
        }
      }
    }
    expect(shared, 'touching shapes of one colour written as separate elements').toEqual([])
  })

  it.each(WRITER_CASES)('draws what has no curve crisp, like the plain code, and keeps every curve smooth — %s', (_name, style, px) => {
    const pieces = piecesOf(qrDrawingToSvg(drawnFor(style, px)))
    const elements = new Map<number, Piece[]>()
    for (const piece of pieces) elements.set(piece.element, [...(elements.get(piece.element) ?? []), piece])
    for (const [element, own] of elements) {
      const hasCurve = own.some((piece) => piece.curved)
      expect(own[0]?.crisp, `element #${element} (${own[0]?.tag}, ${own.length} outlines, curved: ${hasCurve})`).toBe(!hasCurve)
    }
    // And there is always at least one of the kind the styling calls for.
    expect(pieces.some((piece) => piece.crisp)).toBe(true)
  })

  /**
   * The markup draws exactly the drawing — nothing lost, nothing added, nothing
   * moved — read back through the grammar, so a separator the writer leaves out
   * shows up here as geometry. Square outlines may cover several modules of a
   * row; they are compared module by module.
   */
  it.each(WRITER_CASES)('writes exactly the shapes of the drawing, colour by colour, in paint order — %s', (_name, style, px) => {
    const drawing = drawnFor(style, px)
    const pieces = piecesOf(qrDrawingToSvg(drawing))

    // Colour runs in the drawing's order: the ring before its hole, the hole before its core.
    expect(colourRuns(pieces).map((run) => run[0]?.fill)).toEqual(colourRuns(drawing.shapes).map((run) => run[0]?.fill))

    const cells = (box: Box, fill: string): string[] => {
      const out: string[] = []
      for (let y = box.y0; y < box.y1; y += 1) for (let x = box.x0; x < box.x1; x += 1) out.push(`${fill} ${x},${y}`)
      return out
    }
    const sorted = (values: string[]): string[] => [...values].sort()

    const written = { sharp: [] as string[], curved: [] as string[], circles: [] as string[] }
    for (const piece of pieces) {
      if (piece.tag === 'circle') {
        written.circles.push(`${piece.fill} ${piece.centre} r${piece.rx}`)
      } else if (piece.curved) {
        const { x0, y0, x1, y1 } = piece.box
        written.curved.push(`${piece.fill} ${x0},${y0} ${snap(x1 - x0)}x${snap(y1 - y0)} r${piece.rx}/${piece.ry}`)
      } else {
        written.sharp.push(...cells(piece.box, piece.fill))
      }
    }
    const expected = { sharp: [] as string[], curved: [] as string[], circles: [] as string[] }
    for (const shape of drawing.shapes) {
      if (shape.kind === 'circle') {
        expected.circles.push(`${shape.fill} ${shape.cx},${shape.cy} r${shape.r}`)
      } else if (shape.r > 0) {
        // `rx` on a <rect>, as SVG reads it: each axis clamped to half its side.
        const [rx, ry] = [Math.min(shape.r, shape.w / 2), Math.min(shape.r, shape.h / 2)].map(snap)
        expected.curved.push(`${shape.fill} ${snap(shape.x)},${snap(shape.y)} ${snap(shape.w)}x${snap(shape.h)} r${rx}/${ry}`)
      } else {
        expected.sharp.push(...cells({ x0: shape.x, y0: shape.y, x1: shape.x + shape.w, y1: shape.y + shape.h }, shape.fill))
      }
    }
    expect(sorted(written.circles)).toEqual(sorted(expected.circles))
    expect(sorted(written.curved)).toEqual(sorted(expected.curved))
    expect(sorted(written.sharp)).toEqual(sorted(expected.sharp))
  })

  it('escapes the colour attribute, because an SVG is markup', () => {
    const svg = qrDrawingToSvg({
      size: 1,
      version: 1,
      errorCorrectionLevel: 'M',
      shapes: [{ kind: 'rect', x: 0, y: 0, w: 1, h: 1, r: 0, fill: '"><script>x</script>' }],
    })
    expect(svg).not.toContain('<script')
  })
})

describe('qrSvg — the one entry point callers use', () => {
  it('draws a plain style byte for byte as the untouched path does', async () => {
    // The owner's rule: an operator who never opened the setting sees exactly
    // what they saw before styling existed — not a lookalike, the same bytes.
    expect(await qrSvg(LINK, QR_STYLE_PLAIN, 208)).toBe(await QRCode.toString(LINK, qrOptions()))
  })

  it('draws a styled one from the matrix', async () => {
    const style: QrStyle = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }
    expect(await qrSvg(LINK, style, 208)).toBe(
      qrDrawingToSvg(drawQr(LINK, style, { displayPixels: 208 })),
    )
  })

  it('steps dots down to rounded squares when the code is shown small', async () => {
    // 96 CSS px over this 37-module symbol is ~2.6 px per module — the partner
    // block's size, and below the floor dots are allowed at.
    const style: QrStyle = { ...QR_STYLE_PLAIN, modules: 'dots' }
    expect(await qrSvg(LINK, style, 96)).not.toContain('<circle')
    expect(await qrSvg(LINK, style, 400)).toContain('<circle')
  })
})

/* ────────────────────────────────── the logo ───────────────────────────────── */

const LOGO_SRC = '/uploads/branding/brand-mark.png'
/** Any valid PNG `data:` URI — these cases are about where it goes, not what it shows. */
const PNG_HREF =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='
/** 66 bytes, version 5 at M — the link the planner's research numbers were measured on. */
const REFERRAL_66 = 'https://cabinet.example.com/register?ref=clx8k2m9q0000a1b2c3d4e5f6'

const withLogo = (style: QrStyle, size: QrLogoSize = 'large', plate: QrLogoPlate = 'light'): QrStyle => ({
  ...style,
  logo: { src: LOGO_SRC, size, plate },
})

describe('resolveQrStyle — the logo', () => {
  it('keeps a logo that is a relayed upload, with a size and a plate this build knows', () => {
    expect(resolveQrStyle({ modules: 'rounded', logo: { src: LOGO_SRC, size: 'small', plate: 'dark' } })).toEqual({
      ...QR_STYLE_PLAIN,
      modules: 'rounded',
      logo: { src: LOGO_SRC, size: 'small', plate: 'dark' },
    })
    expect(resolveQrStyle({ logo: { src: '/uploads/branding/Mark_2.SVG', size: 'large', plate: 'light' } }).logo).toEqual({
      src: '/uploads/branding/Mark_2.SVG',
      size: 'large',
      plate: 'light',
    })
  })

  it("answers a panel older than the logo — no `logo` key at all — with today's style and no logo", () => {
    expect(resolveQrStyle({ modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' })).toEqual({
      modules: 'dots',
      eyes: 'rounded',
      dark: '#1e3a8a',
      logo: null,
    })
  })

  it('is no logo — never part of one — for any other source, size or plate', () => {
    const logo = (over: Record<string, unknown>): unknown => ({ src: LOGO_SRC, size: 'small', plate: 'light', ...over })
    const refused: ReadonlyArray<readonly [string, unknown]> = [
      ['null', null],
      ['a bare path instead of a block', LOGO_SRC],
      ['an array', [LOGO_SRC, 'small', 'light']],
      ['an https URL', logo({ src: 'https://cdn.example.com/uploads/branding/logo.png' })],
      ['a protocol-relative URL', logo({ src: '//cdn.example.com/uploads/branding/logo.png' })],
      ['a data URI as the source', logo({ src: PNG_HREF })],
      ['a script URL', logo({ src: 'javascript:alert(1)' })],
      ['another upload directory', logo({ src: '/uploads/icons/logo.png' })],
      ['a traversal', logo({ src: '/uploads/branding/../icons/logo.png' })],
      ['a name starting with dots', logo({ src: '/uploads/branding/..logo.png' })],
      ['a query string', logo({ src: '/uploads/branding/logo.png?v=2' })],
      ['a type the loader cannot draw', logo({ src: '/uploads/branding/logo.gif' })],
      ['markup', logo({ src: '/uploads/branding/logo.html' })],
      ['a source that is too long', logo({ src: `/uploads/branding/${'a'.repeat(240)}.png` })],
      ['an unknown size', logo({ size: 'huge' })],
      ['an unknown plate', logo({ plate: 'glass' })],
      ['a missing plate', { src: LOGO_SRC, size: 'small' }],
      ['members on the prototype only', Object.create({ src: LOGO_SRC, size: 'small', plate: 'light' }) as object],
      [
        'keys named after the prototype',
        JSON.parse(`{"constructor":"x","__proto__":{"src":"${LOGO_SRC}"},"size":"small","plate":"light"}`),
      ],
    ]
    for (const [label, raw] of refused) {
      const style = resolveQrStyle({ modules: 'dots', dark: '#1e3a8a', logo: raw })
      expect(style.logo, label).toBeNull()
      // …and only the logo is refused: the rest of the style stands.
      expect([style.modules, style.dark], label).toEqual(['dots', '#1e3a8a'])
    }
  })

  it('reads the source by the rule `isQrLogoSrc` states, which the loader applies again', () => {
    expect(isQrLogoSrc(LOGO_SRC)).toBe(true)
    expect(isQrLogoSrc('/uploads/branding/logo.jpeg')).toBe(true)
    expect(isQrLogoSrc('/uploads/branding/logo.webp')).toBe(true)
    expect(isQrLogoSrc('/uploads/branding/.png')).toBe(false)
    expect(isQrLogoSrc('/uploads/branding/-logo.png')).toBe(false)
    expect(isQrLogoSrc(42)).toBe(false)
  })
})

describe('isPlainStyle — the logo', () => {
  it('is false for a style with a logo, even when every other member is plain — the reset control reads this', () => {
    expect(isPlainStyle(withLogo(QR_STYLE_PLAIN))).toBe(false)
    expect(isPlainStyle({ ...withLogo(QR_STYLE_PLAIN), logo: null })).toBe(true)
  })
})

describe('isQrLogoHref', () => {
  it('lets through a base64 PNG or SVG data URI, and nothing that could load or break out', () => {
    expect(isQrLogoHref(PNG_HREF)).toBe(true)
    expect(isQrLogoHref('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=')).toBe(true)
    for (const href of [
      'https://cdn.example.com/logo.png',
      '/uploads/branding/logo.png',
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
      'data:image/png,raw',
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/png;base64,AAAA" onload="alert(1)',
      `data:image/png;base64,${'A'.repeat(LOGO_HREF_MAX_LENGTH)}`,
      undefined,
    ]) {
      expect(isQrLogoHref(href), String(href).slice(0, 60)).toBe(false)
    }
  })
})

describe('drawQr — with a logo', () => {
  const navy: QrStyle = { ...QR_STYLE_PLAIN, modules: 'rounded', dark: '#1e3a8a' }
  const plan = planQrLogo(REFERRAL_66, withLogo(navy), 208)
  const planned = (): NonNullable<typeof plan> => {
    expect(plan, 'precondition: the research plan for this link').toMatchObject({ level: 'Q', version: 6, knockout: 11 })
    return plan as NonNullable<typeof plan>
  }

  it("encodes at the plan's level and leaves out exactly the knockout's modules — every other module drawn", () => {
    const p = planned()
    const drawing = drawQr(REFERRAL_66, withLogo(navy, 'large', 'dark'), {
      displayPixels: 208,
      logo: { plan: p, href: PNG_HREF },
    })
    expect(drawing.errorCorrectionLevel).toBe('Q')
    const matrix = QRCode.create(REFERRAL_66, { errorCorrectionLevel: 'Q' }).modules
    const q = QUIET_ZONE_MODULES
    const from = (matrix.size - p.knockout) / 2
    // Rounded data modules and function modules are all 1 × 1 rects; the plate is larger.
    const drawn = new Set(
      drawing.shapes
        .filter((s) => s.kind === 'rect' && s.w === 1 && s.h === 1 && s.fill === navy.dark)
        .map((s) => (s.kind === 'rect' ? `${s.y - q},${s.x - q}` : '')),
    )
    const wrong: string[] = []
    let leftOut = 0
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        const inside = row >= from && row < from + p.knockout && col >= from && col < from + p.knockout
        const dark = matrix.get(row, col) === 1
        if (dark && inside) leftOut += 1
        if (drawn.has(`${row},${col}`) !== (dark && !inside)) wrong.push(`${row},${col}`)
      }
    }
    expect(wrong).toEqual([])
    expect(leftOut, 'precondition: the knockout covered dark modules at all').toBeGreaterThan(10)
  })

  it("puts a dark plate one module inside the knockout, rounded, in the code's dark colour — the image inside it", () => {
    const p = planned()
    const drawing = drawQr(REFERRAL_66, withLogo(navy, 'large', 'dark'), {
      displayPixels: 208,
      logo: { plan: p, href: PNG_HREF },
    })
    const plateFrom = QUIET_ZONE_MODULES + (p.modules - p.knockout) / 2 + 1
    const plateWidth = p.knockout - 2
    expect(drawing.shapes.at(-1)).toEqual({
      kind: 'rect',
      x: plateFrom,
      y: plateFrom,
      w: plateWidth,
      h: plateWidth,
      r: plateWidth * LOGO_DARK_PLATE_RADIUS,
      fill: navy.dark,
    })
    const inset = plateWidth * LOGO_DARK_PLATE_INSET
    expect(drawing.logo).toEqual({
      x: plateFrom + inset,
      y: plateFrom + inset,
      w: plateWidth - inset * 2,
      h: plateWidth - inset * 2,
      href: PNG_HREF,
    })
    expect([LOGO_DARK_PLATE_RADIUS, LOGO_DARK_PLATE_INSET]).toEqual([0.22, 0.15])
  })

  it('leaves a light plate as the bare white field, the image filling it inside the moat', () => {
    const p = planned()
    const drawing = drawQr(REFERRAL_66, withLogo(navy), { displayPixels: 208, logo: { plan: p, href: PNG_HREF } })
    const plateFrom = QUIET_ZONE_MODULES + (p.modules - p.knockout) / 2 + 1
    expect(drawing.logo).toEqual({ x: plateFrom, y: plateFrom, w: p.knockout - 2, h: p.knockout - 2, href: PNG_HREF })
    // Nothing larger than a module is drawn in the code's colour but the three eyes' squares.
    const large = drawing.shapes.filter((s) => s.kind === 'rect' && s.w > 1 && s.fill === navy.dark)
    expect(large).toEqual([])
  })

  it('draws the code as if no logo were asked for when the plan, the href or the style does not fit', () => {
    const p = planned()
    const style = withLogo(navy)
    const otherVersion = planQrLogo('https://cabinet.example.com/?campaign=ad_aB3dE6gH9k', withLogo(navy, 'small'), 208)
    expect(otherVersion?.version, 'precondition: a plan for another version').toBe(5)
    const cases: ReadonlyArray<readonly [string, QrStyle, typeof p, string]> = [
      ['a plan for another version', style, otherVersion ?? p, PNG_HREF],
      // The whole symbol: it would clear the finders.
      ['a knockout over function modules', style, { ...p, knockout: p.modules }, PNG_HREF],
      ['an even knockout', style, { ...p, knockout: 10 }, PNG_HREF],
      ['an external href', style, p, 'https://cdn.example.com/logo.png'],
      ['a style without a logo', navy, p, PNG_HREF],
    ]
    for (const [label, s, casePlan, href] of cases) {
      const drawing = drawQr(REFERRAL_66, s, { displayPixels: 208, logo: { plan: casePlan, href } })
      expect(drawing.logo, label).toBeUndefined()
      expect(drawing, label).toEqual(drawQr(REFERRAL_66, s, { displayPixels: 208 }))
    }
  })
})

describe('qrDrawingToSvg — the logo', () => {
  it('writes the image last, once, as the data URI and nothing else', () => {
    const style = withLogo(QR_STYLE_PLAIN, 'small')
    const plan = planQrLogo(REFERRAL_66, style, 208)
    expect(plan).not.toBeNull()
    const svg = qrDrawingToSvg(
      drawQr(REFERRAL_66, style, { displayPixels: 208, logo: { plan: plan as NonNullable<typeof plan>, href: PNG_HREF } }),
    )
    expect(svg.match(/<image\b/g)).toHaveLength(1)
    expect(svg).toMatch(
      /<image href="data:image\/png;base64,[A-Za-z0-9+/=]+" x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+"\/><\/svg>$/,
    )
  })

  it('refuses an external or malformed href even from a drawing built by hand', () => {
    for (const href of ['https://cdn.example.com/logo.png', 'data:image/png;base64,AAAA"/><script>alert(1)</script>']) {
      const svg = qrDrawingToSvg({
        size: 1,
        version: 1,
        errorCorrectionLevel: 'M',
        shapes: [],
        logo: { x: 0, y: 0, w: 1, h: 1, href },
      })
      expect(svg, href).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
    }
  })
})

describe('qrSvg — the logo', () => {
  it('draws the logo when there is a plan AND the loaded image', async () => {
    const style = withLogo(QR_STYLE_PLAIN, 'small')
    const plan = planQrLogo(REFERRAL_66, style, 208)
    expect(plan).toMatchObject({ level: 'M', version: 5, knockout: 7 })
    const svg = await qrSvg(REFERRAL_66, style, 208, PNG_HREF)
    expect(svg).toContain(`<image href="${PNG_HREF}"`)
    expect(svg).toBe(
      qrDrawingToSvg(
        drawQr(REFERRAL_66, style, { displayPixels: 208, logo: { plan: plan as NonNullable<typeof plan>, href: PNG_HREF } }),
      ),
    )
  })

  it('is byte for byte the code without a logo whenever no logo is drawn', async () => {
    const navyDots: QrStyle = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }
    for (const style of [QR_STYLE_PLAIN, navyDots]) {
      const bare = await qrSvg(REFERRAL_66, style, 208)
      const branded = withLogo(style, 'large', 'dark')
      // Configured, not loaded yet — or never.
      expect(await qrSvg(REFERRAL_66, branded, 208)).toBe(bare)
      // Loaded, but no size to plan for.
      expect(await qrSvg(REFERRAL_66, branded, undefined, PNG_HREF)).toBe(await qrSvg(REFERRAL_66, style))
      // Loaded, but at 96 px no symbol can carry one.
      expect(await qrSvg(REFERRAL_66, branded, 96, PNG_HREF)).toBe(await qrSvg(REFERRAL_66, style, 96))
      // Something that is not a loaded image.
      expect(await qrSvg(REFERRAL_66, branded, 208, 'https://cdn.example.com/logo.png')).toBe(bare)
      expect(await qrSvg(REFERRAL_66, branded, 208, '')).toBe(bare)
    }
    // …and for plain members that is `qrcode`'s own writer, untouched.
    expect(await qrSvg(REFERRAL_66, withLogo(QR_STYLE_PLAIN), 208)).toBe(
      await QRCode.toString(REFERRAL_66, qrOptions()),
    )
  })
})

describe('the bytes of every code drawn without a logo are frozen — and a logo nobody loaded changes none of them', () => {
  // sha256 (first 16 hex) of `qrSvg` at no size, 96, 208 and 256 px, each
  // followed by a NUL, computed by a script outside this repository — never by
  // this renderer: a freeze the code under test computed for itself would
  // agree with whatever it drew. Plain styles pin `qrcode`'s own writer, styled
  // ones the matrix path; and a style carrying a logo nobody has loaded must
  // hash the same.
  //
  // First frozen from the renderer at 67bc08c, BEFORE the logo was written.
  // The styled entries were recomputed once since, on 18.09.2026, when touching
  // shapes began to be written as one path (see "How the shapes are written"
  // in `qr-style.ts`): the model — `drawQr`, unchanged — taken from the
  // renderer at 65eb5af and written by a separate implementation of the new
  // writing rule. The plain entries did not move by a byte.
  // prettier-ignore
  const GOLDEN: Readonly<Record<string, string>> = {
    'referral short · plain': 'feb4f31328160785', 'referral short · rounded': 'fd8d5894c75ebcdd',
    'referral short · dots': 'f1a8ff53c4fa0964', 'referral short · rounded eyes': '2cd08792871088bc',
    'referral short · dots navy': '3936267af92cc02c', 'referral short · grey floor': 'b9aa17f7483cf311',
    'referral short · rounded grey': '35b40f6350d36284',
    'invite web · plain': '9b30bdb29c5633fd', 'invite web · rounded': '3965a8cf2233ce8a',
    'invite web · dots': 'f4b2527e29fc0e55', 'invite web · rounded eyes': '9177f2821bbb7b07',
    'invite web · dots navy': '455f01ab9f2a745b', 'invite web · grey floor': '61ae23c8aa5059ac',
    'invite web · rounded grey': '438394de806ad360',
    'referral 66B · plain': '6b695b91565c42f0', 'referral 66B · rounded': 'e24a6a8691015c56',
    'referral 66B · dots': '12a23e8b579e7c5a', 'referral 66B · rounded eyes': 'bd65d68ff74e16f4',
    'referral 66B · dots navy': 'b5e8c17d1462cf0c', 'referral 66B · grey floor': '1e48fdb2dd048702',
    'referral 66B · rounded grey': '264d5a0cbd6bdfe9',
    'bot ad · plain': '47f5ff196e8a50c5', 'bot ad · rounded': '6ec65933097be97a',
    'bot ad · dots': '57de168375a4bb1b', 'bot ad · rounded eyes': 'c51238fcb36614e5',
    'bot ad · dots navy': '0a0bb8adab6e0d5a', 'bot ad · grey floor': '5e8e0d323262d345',
    'bot ad · rounded grey': 'bbbf1942872dabbc',
    'web ad 77B · plain': '524197ab97fde035', 'web ad 77B · rounded': '61e2ab515fb18264',
    'web ad 77B · dots': 'ebbdb4a762070e2c', 'web ad 77B · rounded eyes': '12da3866c78986fc',
    'web ad 77B · dots navy': '0177bbac5420fd73', 'web ad 77B · grey floor': 'dea217c15a0e6f80',
    'web ad 77B · rounded grey': 'ed615b970659da00',
    'subscription · plain': '1f0fdf9b42b686bd', 'subscription · rounded': '5059baeaef73a805',
    'subscription · dots': '20f0e139c7529b70', 'subscription · rounded eyes': '4a70a92bef5ec196',
    'subscription · dots navy': 'e8b74c7e83fd48b9', 'subscription · grey floor': '9df525cfbb3d3abd',
    'subscription · rounded grey': 'a85a37bdac317e2f',
    'free Q · plain': '2248dec6a43fcfcf', 'free Q · rounded': '9e722d8c7b20e73b',
    'free Q · dots': '0c36dc4baa9e744d', 'free Q · rounded eyes': 'f8e2e9bd4ecb2352',
    'free Q · dots navy': '9ed21c9e53d67e32', 'free Q · grey floor': '917bf032f1ce01f7',
    'free Q · rounded grey': '16126f9ff9579798',
    'free H · plain': '679b72144cd861ae', 'free H · rounded': '7f44a130f5e9d85a',
    'free H · dots': '61b938dbfd9b464b', 'free H · rounded eyes': '15b45dde65cb5ff0',
    'free H · dots navy': '482b5f53ce3be59e', 'free H · grey floor': '03a846f6b63e5633',
    'free H · rounded grey': '66413a47b68b33db',
  }

  const TEXTS: ReadonlyArray<readonly [string, string]> = [
    ['referral short', 'https://cabinet.example.com/r/abc123'],
    ['invite web', 'https://cabinet.example.com/register?ref=abc123'],
    ['referral 66B', REFERRAL_66],
    ['bot ad', 'https://t.me/reiwa_bot?start=ad_abc123'],
    ['web ad 77B', 'https://lk.super-fast-vpn-brand-x.com/?campaign=ad_aB3dE6gH9k'],
    [
      'subscription',
      'https://sub.example.com/subscription/9f2c1e7a-4d8b-4b2f-9c31-7a5e6f0b8d14' +
        '?token=aGVsbG8td29ybGQtdGhpcy1pcy1hLXJlYWxpc3RpYy1sZW5ndGgtdG9rZW4',
    ],
    ['free Q', 'https://t.me/ab12345'],
    ['free H', 'abcdefg'],
  ]
  const STYLES: ReadonlyArray<readonly [string, QrStyle]> = [
    ['plain', QR_STYLE_PLAIN],
    ['rounded', { ...QR_STYLE_PLAIN, modules: 'rounded' }],
    ['dots', { ...QR_STYLE_PLAIN, modules: 'dots' }],
    ['rounded eyes', { ...QR_STYLE_PLAIN, eyes: 'rounded' }],
    ['dots navy', { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }],
    ['grey floor', { ...QR_STYLE_PLAIN, dark: '#595959' }],
    ['rounded grey', { modules: 'rounded', eyes: 'rounded', dark: '#595959', logo: null }],
  ]

  async function fingerprint(text: string, style: QrStyle): Promise<string> {
    const hash = createHash('sha256')
    for (const px of [undefined, 96, 208, 256]) {
      hash.update(await qrSvg(text, style, px))
      hash.update('\u0000')
    }
    return hash.digest('hex').slice(0, 16)
  }

  it('holds the fixture to one entry per link and style, so a case cannot fall out of it unnoticed', () => {
    expect(Object.keys(GOLDEN)).toHaveLength(TEXTS.length * STYLES.length)
  })

  it.each(TEXTS)('%s', async (label, text) => {
    for (const [styleLabel, style] of STYLES) {
      const key = `${label} · ${styleLabel}`
      expect(GOLDEN[key], `no golden entry for ${key}`).toMatch(/^[0-9a-f]{16}$/)
      expect(await fingerprint(text, style), key).toBe(GOLDEN[key])
      expect(await fingerprint(text, withLogo(style, 'large', 'dark')), `${key}, with a logo not loaded`).toBe(
        GOLDEN[key],
      )
    }
  })
})
