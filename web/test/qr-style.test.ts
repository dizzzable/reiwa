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

describe('qrDrawingToSvg', () => {
  it('writes one element per shape, inside the viewBox of the drawing', () => {
    const drawing = drawQr(LINK, { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null })
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

describe('the bytes of every code drawn without a logo are frozen at what the renderer drew before logos existed', () => {
  // sha256 (first 16 hex) of `qrSvg` at no size, 96, 208 and 256 px, each
  // followed by a NUL — computed from the renderer at HEAD 67bc08c, BEFORE the logo was
  // written, by a script outside this repository. Not from this renderer: a
  // freeze the code under test computed for itself would agree with whatever
  // it drew. Plain styles pin `qrcode`'s own writer, styled ones the matrix
  // path; and a style carrying a logo nobody has loaded must hash the same.
  // prettier-ignore
  const GOLDEN: Readonly<Record<string, string>> = {
    'referral short · plain': 'feb4f31328160785', 'referral short · rounded': 'be80b418911714a0',
    'referral short · dots': '982ff0e29539a89f', 'referral short · rounded eyes': 'da1e602c5e0a414f',
    'referral short · dots navy': '0ab845d9c57699ec', 'referral short · grey floor': '6bdfff47fb07b636',
    'referral short · rounded grey': '0d64dcf3706ca99c',
    'invite web · plain': '9b30bdb29c5633fd', 'invite web · rounded': 'e4db251af4ed8b61',
    'invite web · dots': '567d5a76f1472303', 'invite web · rounded eyes': '3dd57ef95dc0f105',
    'invite web · dots navy': '828d43d8ab0a31b0', 'invite web · grey floor': '7199d9003ad5ed12',
    'invite web · rounded grey': '0a674e8faa50b233',
    'referral 66B · plain': '6b695b91565c42f0', 'referral 66B · rounded': '3b3d6d7415173fb8',
    'referral 66B · dots': 'f2b6fbffef338837', 'referral 66B · rounded eyes': '4ff87c0072e321f5',
    'referral 66B · dots navy': '7b89f612945320fb', 'referral 66B · grey floor': 'e91cdbd8665583bf',
    'referral 66B · rounded grey': 'c02459e70ffa3f96',
    'bot ad · plain': '47f5ff196e8a50c5', 'bot ad · rounded': '5ed139f110a61597',
    'bot ad · dots': '75aed2a0a6244e00', 'bot ad · rounded eyes': '7eb21501fe570c17',
    'bot ad · dots navy': 'a3cc98ce5c38b077', 'bot ad · grey floor': 'c28ca8b9be37eab0',
    'bot ad · rounded grey': 'bab7cad520d86d50',
    'web ad 77B · plain': '524197ab97fde035', 'web ad 77B · rounded': '0309c9ab83b23f6d',
    'web ad 77B · dots': '1f42b4b380bbb093', 'web ad 77B · rounded eyes': 'dc9e891ba3d6f873',
    'web ad 77B · dots navy': 'ae757df78defb70b', 'web ad 77B · grey floor': '0f25c190f3a7d89a',
    'web ad 77B · rounded grey': '7c25d1b7ac3042cf',
    'subscription · plain': '1f0fdf9b42b686bd', 'subscription · rounded': '530e24c20e198508',
    'subscription · dots': 'fed5727ae0593ae0', 'subscription · rounded eyes': '684ebe848e87d7ae',
    'subscription · dots navy': 'f5955c70a6ec422a', 'subscription · grey floor': '675cc651ca11752c',
    'subscription · rounded grey': 'f5ecad3675a298b5',
    'free Q · plain': '2248dec6a43fcfcf', 'free Q · rounded': '8d893f5082c13af8',
    'free Q · dots': '87498c36b75c40d0', 'free Q · rounded eyes': '009c1b21bfe15a3d',
    'free Q · dots navy': 'a5fc37323e8c0f48', 'free Q · grey floor': 'cf96bc174cc33c96',
    'free Q · rounded grey': 'adc601f29503e183',
    'free H · plain': '679b72144cd861ae', 'free H · rounded': 'e4fc152b576f74ae',
    'free H · dots': 'e7801d493a6bb24c', 'free H · rounded eyes': '42d682a5d81d5f55',
    'free H · dots navy': 'aabe4bbd79b4252b', 'free H · grey floor': 'e7c8478647ad89dc',
    'free H · rounded grey': 'd50ab8abe4341b0c',
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
