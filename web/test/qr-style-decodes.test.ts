/**
 * A styled code must still READ — proven by decoding it with the strictest
 * reader in the chain, not by looking at it.
 *
 * The reader is ZXing (`@zxing/library`): the algorithm family v2rayNG embeds,
 * with the same shape of hints — QR only, TRY_HARDER, a HybridBinarizer — and
 * no inversion, because the JS port has none, exactly like v2rayNG's camera
 * path. A test that decoded with a lenient reader would bless codes the least
 * forgiving customer cannot scan; the inverted-code control at the bottom proves
 * this one is not lenient.
 *
 * Every style is read twice over:
 *
 *   - POINT-SAMPLED, at 3, 5 and 8 pixels per module — the geometry exactly as
 *     drawn. Necessary, and on its own not enough: under point sampling a dot a
 *     quarter of a module wide decoded perfectly, because the reader's centre
 *     sample lands squarely on it. Measured by mutation, not supposed;
 *   - THROUGH A CAMERA model — pixels that integrate light, a grid that does
 *     not line up with the code's, and a little defocus — at 4.5 and 6.5 pixels
 *     per module. This is where fill matters, and where that shrunken dot fails.
 *
 * Both links are read: the short referral link and the longest thing the
 * cabinet encodes, the subscription link, which sets the symbol version and
 * therefore the module size.
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from '@zxing/library'
import { describe, expect, it } from 'vitest'

import { QR_STYLE_PLAIN, type QrStyle, drawQr, isUsableDark } from '@/lib/qr-style'

import { type LuminanceImage, blur, rasterise, rasteriseCamera } from './support/qr-raster'

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
])

function decode(image: LuminanceImage): string {
  const source = new RGBLuminanceSource(image.luminance, image.width, image.height)
  const bitmap = new BinaryBitmap(new HybridBinarizer(source))
  return new QRCodeReader().decode(bitmap, HINTS).getText()
}

const REFERRAL = 'https://cabinet.example.com/r/abc123'
const SUBSCRIPTION =
  'https://sub.example.com/subscription/9f2c1e7a-4d8b-4b2f-9c31-7a5e6f0b8d14' +
  '?token=aGVsbG8td29ybGQtdGhpcy1pcy1hLXJlYWxpc3RpYy1sZW5ndGgtdG9rZW4'

const LINKS = [
  ['referral link', REFERRAL],
  ['subscription link', SUBSCRIPTION],
] as const

const STYLES: ReadonlyArray<readonly [string, QrStyle]> = [
  ['rounded modules', { ...QR_STYLE_PLAIN, modules: 'rounded' }],
  ['dots', { ...QR_STYLE_PLAIN, modules: 'dots' }],
  ['rounded eyes', { ...QR_STYLE_PLAIN, eyes: 'rounded' }],
  ['dots, rounded eyes, brand navy', { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' }],
  // The palest dark colour the resolver lets through: #595959, 7.00:1 against
  // white. The floor used to be WCAG's 4.5:1 (#767676), and this very case —
  // rounded, subscription link, through the camera at 6.5 px/module — failed
  // on it. Two rows, so a failure says whether the colour or the shape did it.
  ['square modules, grey at the contrast floor', { ...QR_STYLE_PLAIN, dark: '#595959' }],
  ['rounded, grey at the contrast floor', { modules: 'rounded', eyes: 'rounded', dark: '#595959' }],
  // The worst cell of the panel's own grid: the least ink of the three
  // module shapes and the palest colour the resolver lets through, together.
  ['dots, rounded eyes, grey at the contrast floor', { modules: 'dots', eyes: 'rounded', dark: '#595959' }],
]

describe('a styled code decodes with the strictest reader — point-sampled', () => {
  for (const [name, style] of STYLES) {
    for (const [label, text] of LINKS) {
      for (const ppm of [3, 5, 8]) {
        it(`${name} · ${label} · ${ppm} px/module`, () => {
          const drawing = drawQr(text, style, { pixelsPerModule: ppm })
          expect(decode(rasterise(drawing, ppm))).toBe(text)
        })
      }
    }
  }

  it('survives a blur on top of the point-sampled image', () => {
    const drawing = drawQr(
      SUBSCRIPTION,
      { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' },
      { pixelsPerModule: 6 },
    )
    expect(decode(blur(rasterise(drawing, 6), 1))).toBe(SUBSCRIPTION)
  })
})

describe('…and through a camera: integrating pixels, defocus, a grid that does not line up', () => {
  // Plain first, as a control for the model itself: if a plain code failed
  // here, the model would be too harsh to judge anything else by.
  const CAMERA_STYLES: ReadonlyArray<readonly [string, QrStyle]> = [
    ['plain (control for the model)', QR_STYLE_PLAIN],
    ...STYLES,
  ]
  for (const [name, style] of CAMERA_STYLES) {
    for (const [label, text] of LINKS) {
      for (const ppm of [4.5, 6.5]) {
        it(`${name} · ${label} · ${ppm} px/module`, () => {
          const drawing = drawQr(text, style, { pixelsPerModule: ppm })
          expect(decode(rasteriseCamera(drawing, ppm))).toBe(text)
        })
      }
    }
  }
})

describe('the reader is as strict as the customers it stands for', () => {
  it('refuses through the camera what it reads point-sampled — so the model is one', () => {
    // Anti-vacuous anchor for the CAMERA, next to the one below for the reader.
    // Everything the camera cases stand for — the 7:1 floor, the dot's 0.86
    // diameter — rests on this model being harsher than point sampling, and
    // every case above only asks it to pass. Strip the supersampling and the
    // defocus out of `rasteriseCamera` and each one goes on passing while the
    // model measures nothing.
    //
    // `#767676` is WCAG's 4.5:1 text grey, the floor this file's colour cases
    // used to sit at. `drawQr` takes any colour; `resolveQrStyle` is what
    // refuses this one, and the measurement that made it refuse is this.
    const style: QrStyle = { modules: 'rounded', eyes: 'rounded', dark: '#767676' }
    expect(isUsableDark(style.dark), 'the resolver has stopped refusing this grey').toBe(false)
    const drawing = drawQr(SUBSCRIPTION, style, { pixelsPerModule: 6.5 })
    expect(decode(rasterise(drawing, 6.5)), 'point-sampled, this grey still reads').toBe(SUBSCRIPTION)
    expect(() => decode(rasteriseCamera(drawing, 6.5))).toThrow()
  })

  it('does NOT read an inverted code — so every pass above is not leniency', () => {
    // Anti-vacuous anchor. v2rayNG's camera path never tries inversion; if this
    // reader did, the cases above could pass a code that customer cannot scan.
    const drawing = drawQr(REFERRAL, QR_STYLE_PLAIN)
    // First, the same code the right way round reads fine at this size…
    expect(decode(rasterise(drawing, 5))).toBe(REFERRAL)
    // …and with its palette flipped, it must not.
    const inverted = {
      ...drawing,
      shapes: drawing.shapes.map((shape) => ({
        ...shape,
        fill: shape.fill === '#ffffff' ? '#000000' : '#ffffff',
      })),
    }
    expect(() => decode(rasterise(inverted, 5))).toThrow()
  })
})
