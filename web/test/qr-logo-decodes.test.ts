/**
 * A code with a logo must still READ — proven by decoding every plan the
 * planner makes on the links the cabinet draws, with the strictest reader in
 * the chain.
 *
 * The reader and both image models are `qr-style-decodes.test.ts`'s: ZXing with
 * v2rayNG's hints and no inversion; a CAMERA that integrates light, blurs a
 * little and does not line its pixels up with the modules, run at the plan's own
 * pixels per module — the size the code is really shown at; and POINT-SAMPLED
 * geometry, on a grid that lines up with the modules, at the next whole pixel
 * count above that. Not at the fractional count itself: point sampling on a
 * misaligned grid is harsher than any sensor, and measured so — logo-less plain
 * codes of realistic links failed it 10 times in 150 at 208 px, where the
 * camera model failed 2.
 *
 * ── Paired with today's code ────────────────────────────────────────────────
 *
 * The question a logo raises is whether it breaks a code that reads without
 * it. So every case is judged against TODAY'S code for the same link, style and
 * size — no logo, its own free level — under the same model: when that reads,
 * the logo code must read too. When today's code does not read under a model,
 * the case says nothing about logos and is counted, not asserted: ZXing misreads
 * a few plain codes on its own (here, point-sampled, the 45-byte bot link), and
 * a sweep that asserted on those would be measuring the reader.
 *
 * ── Which images ────────────────────────────────────────────────────────────
 *
 * The logo is an image only a browser paints (`support/qr-raster.ts` refuses to
 * skip it), so it is MODELLED by shapes in the box the renderer gives it. The
 * sweep asserts on FILLED marks — nothing, a solid square of ink, detail finer
 * than a module; on the dark plate, the plate alone and a small light glyph.
 *
 * Two classes are not "reads everywhere", and each is pinned below as failing,
 * because no rule about SIZE can exclude either — they depend on the picture
 * and on the link's own modules. Both are what the panel's decoder check
 * exists to catch:
 *
 *   - FINDER-SHAPED marks — a QR eye, a bullseye — fail under every plan whose
 *     plate can hold one (k ≥ 9);
 *   - a thin dark edge around a light interior next to the one-module moat — a
 *     ring, a light image filling the dark plate — or a solid 5-module core in
 *     that moat, supplies half of a 1:1:3:1:1 cross-section, and where the
 *     link's modules supply the other half ZXing confirms a false finder and
 *     drops a real one. Measured over 300 random realistic links at 208 and
 *     256 px: 1–10 codes in 1 200 broken per mark, 5–7 in 1 200 MENDED by the
 *     same marks — against 49 in 1 200 the same codes fail with no logo at all.
 *
 * ── And the anchors that keep a pass meaningful ─────────────────────────────
 *
 * A knockout past the budget (13 modules on the 66-byte referral link at M) must
 * not read — so passing is the budget at work, not a lenient reader.
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

import { type QrLogoPlan, codewordLayout, knockoutBudget, planQrLogo } from '@/lib/qr-logo'
import {
  QR_STYLE_PLAIN,
  type QrDrawing,
  type QrLogoImage,
  type QrLogoPlate,
  type QrShape,
  type QrStyle,
  drawQr,
} from '@/lib/qr-style'

import { LOGO_LINKS, REFERRAL_66 } from './support/qr-links'
import { type LuminanceImage, rasterise, rasteriseCamera, withMark } from './support/qr-raster'

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
])

function reads(image: LuminanceImage, text: string): boolean {
  try {
    const source = new RGBLuminanceSource(image.luminance, image.width, image.height)
    return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)), HINTS).getText() === text
  } catch {
    return false
  }
}

type Model = 'camera' | 'point-sampled'
const MODELS: readonly Model[] = ['camera', 'point-sampled']

/** The model's picture of a drawing shown at `pixelsPerModule` CSS px. */
function picture(drawing: QrDrawing, pixelsPerModule: number, model: Model): LuminanceImage {
  return model === 'camera'
    ? rasteriseCamera(drawing, pixelsPerModule)
    : rasterise(drawing, Math.ceil(pixelsPerModule))
}

/** Any valid PNG `data:` URI: the image is modelled, so its bytes never matter. */
const HREF =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='

/** The styles `qr-style-decodes.test.ts` reads, the plain control first. */
const STYLES: ReadonlyArray<readonly [string, QrStyle]> = [
  ['plain', QR_STYLE_PLAIN],
  ['rounded modules', { ...QR_STYLE_PLAIN, modules: 'rounded' }],
  ['dots', { ...QR_STYLE_PLAIN, modules: 'dots' }],
  ['rounded eyes', { ...QR_STYLE_PLAIN, eyes: 'rounded' }],
  ['dots, rounded eyes, brand navy', { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }],
  ['square modules, grey at the contrast floor', { ...QR_STYLE_PLAIN, dark: '#595959' }],
  ['rounded, grey at the contrast floor', { modules: 'rounded', eyes: 'rounded', dark: '#595959', logo: null }],
  ['dots, rounded eyes, grey at the contrast floor', { modules: 'dots', eyes: 'rounded', dark: '#595959', logo: null }],
]

type Mark = (box: QrLogoImage) => readonly QrShape[]
const INK = '#000000'
const PAPER = '#ffffff'
const rect = (x: number, y: number, w: number, h: number, r: number, fill: string): QrShape => ({
  kind: 'rect',
  x,
  y,
  w,
  h,
  r,
  fill,
})
const circle = (cx: number, cy: number, r: number, fill: string): QrShape => ({ kind: 'circle', cx, cy, r, fill })
const centre = (box: QrLogoImage): readonly [number, number] => [box.x + box.w / 2, box.y + box.h / 2]

/** Detail finer than a module: a checkerboard of half-module cells over the whole box. */
const checker =
  (fill: string): Mark =>
  (box) => {
    const cells = Math.max(2, Math.round(box.w * 2))
    const cell = box.w / cells
    const out: QrShape[] = []
    for (let i = 0; i < cells; i += 1) {
      for (let j = 0; j < cells; j += 1) {
        if ((i + j) % 2 === 0) out.push(rect(box.x + i * cell, box.y + j * cell, cell, cell, 0, fill))
      }
    }
    return out
  }

const TRANSPARENT: Mark = () => []
const SOLID_INK: Mark = (box) => [rect(box.x, box.y, box.w, box.h, 0, INK)]
const LIGHT_GLYPH: Mark = (box) => [circle(...centre(box), box.w * 0.3, PAPER)]
const RING: Mark = (box) => [circle(...centre(box), box.w / 2, INK), circle(...centre(box), box.w * 0.3, PAPER)]
const LIGHT_FILL: Mark = (box) => [rect(box.x, box.y, box.w, box.h, 0, PAPER)]

/** The marks the sweep asserts on — see the header for the two classes it does not. */
const FILLED_MARKS: Readonly<Record<QrLogoPlate, ReadonlyArray<readonly [string, Mark]>>> = {
  light: [
    ['a transparent image', TRANSPARENT],
    ['a solid square of ink', SOLID_INK],
    ['detail finer than a module', checker(INK)],
  ],
  dark: [
    ['the plate alone', TRANSPARENT],
    ['a small light glyph', LIGHT_GLYPH],
  ],
}

/** A QR finder at the module pitch, centred — seven modules: ring, gap, core. */
const EYE: Mark = (box) => {
  const [cx, cy] = centre(box)
  return [
    rect(cx - 3.5, cy - 3.5, 7, 7, 0, INK),
    rect(cx - 2.5, cy - 2.5, 5, 5, 0, PAPER),
    rect(cx - 1.5, cy - 1.5, 3, 3, 0, INK),
  ]
}
/** The same proportions, round. */
const BULLSEYE: Mark = (box) => {
  const [cx, cy] = centre(box)
  return [circle(cx, cy, 3.5, INK), circle(cx, cy, 2.5, PAPER), circle(cx, cy, 1.5, INK)]
}

const logoStyle = (style: QrStyle, plate: QrLogoPlate, size: 'small' | 'large'): QrStyle => ({
  ...style,
  logo: { src: '/uploads/branding/logo.png', size, plate },
})

interface Planned {
  readonly key: string
  readonly text: string
  readonly px: number
  readonly size: 'small' | 'large'
  readonly plan: QrLogoPlan
}

/** Every distinct plan the planner makes on the realistic links, at the sizes a logo is shown at. */
function distinctPlans(): Planned[] {
  const seen = new Map<string, Planned>()
  for (const [label, text] of LOGO_LINKS) {
    for (const px of [208, 256]) {
      for (const size of ['small', 'large'] as const) {
        const plan = planQrLogo(text, logoStyle(QR_STYLE_PLAIN, 'light', size), px)
        if (plan === null) continue
        const key = `${plan.level} v${plan.version} k=${plan.knockout} at ${px} px (${plan.pixelsPerModule.toFixed(2)} px/module, ${label})`
        const identity = `${plan.level}/${plan.version}/${plan.knockout}/${px}`
        if (!seen.has(identity)) seen.set(identity, { key, text, px, size, plan })
      }
    }
  }
  return [...seen.values()]
}

/** The drawing of `text` with `plan`'s logo, the image modelled by `mark`. */
function withLogo(planned: Planned, style: QrStyle, plate: QrLogoPlate, mark: Mark): QrDrawing {
  const drawing = drawQr(planned.text, logoStyle(style, plate, planned.size), {
    displayPixels: planned.px,
    logo: { plan: planned.plan, href: HREF },
  })
  // The renderer drew THIS plan's logo — not a logo-less code by another road.
  expect(drawing.logo, `${planned.key}: no logo was drawn`).toBeDefined()
  expect([drawing.errorCorrectionLevel, drawing.size]).toEqual([planned.plan.level, planned.plan.modules + 8])
  return withMark(drawing, mark)
}

const PLANS = distinctPlans()
const tally = { decodes: 0, excluded: [] as string[], started: Date.now() }

describe('a planned logo never breaks a code that reads — every plan × style × plate × filled mark × model', () => {
  it('has plans to judge — the sweep below is not empty', () => {
    // Anti-vacuous anchor, and a record of what the sweep covers.
    expect(PLANS.length).toBe(18)
    expect(PLANS.some((planned) => planned.plan.knockout >= 11)).toBe(true)
    expect(new Set(PLANS.map((planned) => planned.plan.level))).toEqual(new Set(['M', 'Q', 'H']))
  })

  for (const planned of PLANS) {
    for (const [styleName, style] of STYLES) {
      it(`${planned.key} · ${styleName}`, () => {
        const today = drawQr(planned.text, style, { displayPixels: planned.px })
        const failures: string[] = []
        let asserted = 0
        for (const model of MODELS) {
          const todayReads = reads(picture(today, planned.px / today.size, model), planned.text)
          tally.decodes += 1
          if (!todayReads) tally.excluded.push(`${planned.key} · ${styleName} · ${model}`)
          for (const plate of ['light', 'dark'] as const) {
            for (const [markName, mark] of FILLED_MARKS[plate]) {
              const logoReads = reads(
                picture(withLogo(planned, style, plate, mark), planned.plan.pixelsPerModule, model),
                planned.text,
              )
              tally.decodes += 1
              if (!todayReads) continue
              asserted += 1
              if (!logoReads) failures.push(`${plate} plate, ${markName}, ${model}`)
            }
          }
        }
        expect(failures, `today's code reads and the logo code does not`).toEqual([])
        // Nothing here passes by excluding: the camera model reads today's code
        // for every plan and style, so at least those cases were asserted.
        expect(asserted).toBeGreaterThanOrEqual(FILLED_MARKS.light.length + FILLED_MARKS.dark.length)
      })
    }
  }

  it('asserted nearly everything it drew — exclusions are the reader, and few', () => {
    // Runs after the sweep (same file, in order). Every exclusion is today's
    // code failing ZXing on its own; if they grew, the sweep would be passing
    // by not asserting.
    const cases = PLANS.length * STYLES.length * MODELS.length
    console.info(
      `qr-logo decodes: ${PLANS.length} distinct plans × ${STYLES.length} styles, ${tally.decodes} decodes in ` +
        `${((Date.now() - tally.started) / 1000).toFixed(1)} s; ${tally.excluded.length} of ${cases} cases excluded ` +
        `(today's code does not read under that model): ${tally.excluded.join('; ') || 'none'}`,
    )
    expect(tally.excluded.every((key) => key.endsWith('point-sampled'))).toBe(true)
    expect(tally.excluded.length).toBeLessThanOrEqual(Math.floor(cases * 0.03))
  })
})

describe('the reader refuses what the rules refuse — so every pass above means something', () => {
  it('does NOT read a knockout past the budget: 13 modules on the 66-byte referral link at M', () => {
    const planned = planQrLogo(REFERRAL_66, logoStyle(QR_STYLE_PLAIN, 'light', 'small'), 208)
    expect(planned, 'precondition: the planner itself plans k = 7 here').toMatchObject({
      level: 'M',
      version: 5,
      knockout: 7,
    })
    const plan = planned as QrLogoPlan
    const layout = codewordLayout(QRCode.create(REFERRAL_66, { errorCorrectionLevel: 'M' }).modules, 5, 'M')
    const budget = knockoutBudget(layout, 13)
    expect(budget?.budgetUse, 'precondition: 13 is past what the worst block corrects').toBeGreaterThan(1)
    const oversized: Planned = {
      key: 'M v5 k=13 at 208 px',
      text: REFERRAL_66,
      px: 208,
      size: 'small',
      plan: { ...plan, knockout: 13, platePixels: 13 * plan.pixelsPerModule, budgetUse: budget?.budgetUse ?? Number.NaN },
    }

    const read: string[] = []
    let tried = 0
    for (const [styleName, style] of STYLES) {
      for (const plate of ['light', 'dark'] as const) {
        for (const [markName, mark] of FILLED_MARKS[plate].slice(0, 2)) {
          const drawing = withLogo(oversized, style, plate, mark)
          tried += 2
          if (reads(rasteriseCamera(drawing, plan.pixelsPerModule), REFERRAL_66)) {
            read.push(`${styleName}, ${plate}, ${markName}, camera`)
          }
          if (reads(rasterise(drawing, 8), REFERRAL_66)) read.push(`${styleName}, ${plate}, ${markName}, point @8`)
        }
      }
    }
    tally.decodes += tried
    expect(tried).toBe(STYLES.length * 2 * 2 * 2)
    expect(read).toEqual([])
  })

  it('does NOT read a finder-shaped mark wherever the plate can hold one (k ≥ 9) — under any plan, in any style', () => {
    const holding = PLANS.filter((planned) => planned.plan.knockout >= 9)
    expect(holding.length, 'precondition: plans whose plate holds a 7-module mark').toBe(8)
    const read: string[] = []
    let tried = 0
    for (const planned of holding) {
      for (const [styleName, style] of STYLES) {
        for (const [markName, mark] of [
          ['an eye', EYE],
          ['a bullseye', BULLSEYE],
        ] as const) {
          tried += 1
          if (reads(rasteriseCamera(withLogo(planned, style, 'light', mark), planned.plan.pixelsPerModule), planned.text)) {
            read.push(`${planned.key} · ${styleName} · ${markName}`)
          }
        }
      }
    }
    tally.decodes += tried
    expect(tried).toBe(holding.length * STYLES.length * 2)
    expect(read).toEqual([])
  })

  it('does NOT read an enclosing mark where the link completes the lookalike — the 38-byte bot link at H v5, k = 7', () => {
    // Data-dependent, and pinned as such: the same marks read on the other 13
    // links, and the filled marks read on this one (the sweep above).
    const planned = PLANS.find((candidate) => candidate.key.startsWith('H v5 k=7 at 208 px'))
    expect(planned?.key, 'precondition: the plan').toContain('bot ad 38 B')
    const here = planned as Planned
    const unreadable = (mark: Mark, plate: QrLogoPlate, style: QrStyle, model: Model): boolean =>
      !reads(picture(withLogo(here, style, plate, mark), here.plan.pixelsPerModule, model), here.text)

    // A light image filling the dark plate leaves a thin dark frame: no style reads it through the camera.
    const framed = STYLES.filter(([, style]) => unreadable(LIGHT_FILL, 'dark', style, 'camera')).map(([name]) => name)
    expect(framed).toEqual(STYLES.map(([name]) => name))
    // A ring on the light plate, plain: neither model.
    expect(MODELS.filter((model) => unreadable(RING, 'light', QR_STYLE_PLAIN, model))).toEqual(MODELS)
    tally.decodes += STYLES.length + MODELS.length
  })

  it('does NOT read the bare dark plate on a link whose modules complete a finder around it', () => {
    // Found by a random sweep, one of ~10 codes in 1 200: a solid 5-module core
    // inside the one-module moat is a 1:1:3:1:1 at 1.28 modules once the data
    // beside it supplies the outer ring, and ZXing confirms it on six rows. The
    // same link reads today, and reads with a transparent image on a light plate.
    const text = 'https://bg3g9myvfgbm96i02.example.com/?campaign=ad_ibz0EZb5RR'
    const plan = planQrLogo(text, logoStyle(QR_STYLE_PLAIN, 'dark', 'small'), 208)
    expect(plan, 'precondition: the plan').toMatchObject({ level: 'Q', version: 6, knockout: 7 })
    const here: Planned = { key: 'Q v6 k=7 at 208 px', text, px: 208, size: 'small', plan: plan as QrLogoPlan }
    const today = drawQr(text, QR_STYLE_PLAIN, { displayPixels: 208 })

    expect(reads(rasteriseCamera(today, 208 / today.size), text), "today's code").toBe(true)
    expect(reads(rasteriseCamera(withLogo(here, QR_STYLE_PLAIN, 'light', TRANSPARENT), here.plan.pixelsPerModule), text)).toBe(true)
    expect(reads(rasteriseCamera(withLogo(here, QR_STYLE_PLAIN, 'dark', TRANSPARENT), here.plan.pixelsPerModule), text)).toBe(false)
    tally.decodes += 3
  })
})
