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
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

import { QUIET_ZONE_MODULES, qrOptions, relativeLuminance } from '@/lib/qr-options'
import {
  MAX_DARK_LUMINANCE,
  MIN_PIXELS_PER_MODULE_FOR_DOTS,
  QR_STYLE_PLAIN,
  type QrDrawing,
  type QrStyle,
  drawQr,
  freeErrorCorrectionLevel,
  isPlainStyle,
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

describe('qrDrawingToSvg', () => {
  it('writes one element per shape, inside the viewBox of the drawing', () => {
    const drawing = drawQr(LINK, { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' })
    const svg = qrDrawingToSvg(drawing)
    expect(svg).toContain(`viewBox="0 0 ${drawing.size} ${drawing.size}"`)
    const elements = (svg.match(/<(rect|circle)\b/g) ?? []).length
    expect(elements).toBe(drawing.shapes.length)
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
    const style: QrStyle = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' }
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
