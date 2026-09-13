/**
 * The logo planner, statically: the numbers it plans from, and the rules every
 * plan it returns keeps.
 *
 * Whether a planned logo READS is proven by decoding, in
 * `qr-logo-decodes.test.ts`. What is proven here is what a decoder cannot show
 * clearly enough to blame:
 *
 *   - the block table is ISO's, entry for entry, as BOTH the encoder that lays
 *     the blocks out (`qrcode`) and the reader that corrects them (ZXing) have it;
 *   - the placement map is the one the reader reads — `t` errors placed in one
 *     block by the map still decode, `t + 1` do not, and `2t` split across two
 *     blocks do — which is also the budget's premise: errors, not erasures;
 *   - over every realistic link, at every size a code is shown at, each plan
 *     keeps every rule — recomputed here from the encoder's own matrix, not by
 *     asking the planner — and is the best plan those rules allow.
 *
 * The rules are written as LITERALS in the checks — 4 px, 0.5, 7, 20% and 30% —
 * never read from the module: a check that read `LOGO_MAX_BUDGET_USE` would move
 * with a mutation of it and pass.
 */
import { createRequire } from 'node:module'

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeDecoderErrorCorrectionLevel,
  QRCodeReader,
  QRCodeVersion,
  RGBLuminanceSource,
} from '@zxing/library'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

import {
  type CodewordLayout,
  FUNCTION_MODULE,
  LOGO_DISPLAY_PIXELS,
  LOGO_MAX_BUDGET_USE,
  LOGO_MAX_WIDTH_PERCENT,
  LOGO_MIN_KNOCKOUT,
  LOGO_MIN_PIXELS_PER_MODULE,
  LOGO_MOAT_MODULES,
  type QrLogoPlan,
  REMAINDER_BIT,
  codewordLayout,
  errorCorrectionBlocks,
  knockoutBudget,
  knockoutIsClear,
  planQrLogo,
} from '@/lib/qr-logo'
import { MIN_PIXELS_PER_MODULE_FOR_DOTS, QR_STYLE_PLAIN, type QrShape, type QrStyle } from '@/lib/qr-style'

import { LOGO_LINKS, REFERRAL_66 } from './support/qr-links'
import { rasterise } from './support/qr-raster'

const require = createRequire(import.meta.url)
type EncoderLevel = { readonly bit: number }
const ECCode = require('qrcode/lib/core/error-correction-code') as {
  getBlocksCount(version: number, level: EncoderLevel): number
  getTotalCodewordsCount(version: number, level: EncoderLevel): number
}
const ECLevel = require('qrcode/lib/core/error-correction-level') as Record<'L' | 'M' | 'Q' | 'H', EncoderLevel>
const Utils = require('qrcode/lib/core/utils') as { getSymbolTotalCodewords(version: number): number }

const LEVELS = ['L', 'M', 'Q', 'H'] as const
const LOGO_LEVELS = ['M', 'Q', 'H'] as const

/** ISO/IEC 18004 Table 1: remainder bits after the last codeword, by version. */
function remainderBits(version: number): number {
  if (version === 1) return 0
  if (version <= 6) return 7
  if (version <= 13) return 0
  if (version <= 20) return 3
  if (version <= 27) return 4
  if (version <= 34) return 3
  return 0
}

const withLogo = (size: 'small' | 'large', plate: 'light' | 'dark' = 'light'): QrStyle => ({
  ...QR_STYLE_PLAIN,
  logo: { src: '/uploads/branding/logo.png', size, plate },
})

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]],
  [DecodeHintType.TRY_HARDER, true],
])

describe('the error-correction block table', () => {
  it("is ISO's, entry for entry, as the encoder and the reader both have it — v1–40 at L, M, Q and H", () => {
    let compared = 0
    for (let version = 1; version <= 40; version += 1) {
      const reader = QRCodeVersion.getVersionForNumber(version)
      for (const level of LEVELS) {
        const ours = errorCorrectionBlocks(version, level)
        const where = `v${version}-${level}`
        expect(ours.blocks, `${where} blocks vs qrcode`).toBe(ECCode.getBlocksCount(version, ECLevel[level]))
        expect(ours.ecCodewords, `${where} EC codewords vs qrcode`).toBe(
          ECCode.getTotalCodewordsCount(version, ECLevel[level]),
        )
        const blocks = reader.getECBlocksForLevel(QRCodeDecoderErrorCorrectionLevel.fromString(level))
        expect(ours.blocks, `${where} blocks vs ZXing`).toBe(blocks.getNumBlocks())
        expect(ours.ecCodewords, `${where} EC codewords vs ZXing`).toBe(blocks.getTotalECCodewords())
        compared += 1
      }
      // And the two agree on the symbol's total, which the map derives on its own.
      expect(reader.getTotalCodewords(), `v${version} total codewords`).toBe(Utils.getSymbolTotalCodewords(version))
    }
    expect(compared).toBe(160)
  })

  it('refuses a version or level it has no row for, instead of answering zero', () => {
    expect(() => errorCorrectionBlocks(0, 'M')).toThrow(RangeError)
    expect(() => errorCorrectionBlocks(41, 'M')).toThrow(RangeError)
    expect(errorCorrectionBlocks(5, 'medium')).toEqual(errorCorrectionBlocks(5, 'M'))
  })
})

describe('the codeword placement map', () => {
  it('gives every codeword exactly eight modules, and the totals and block lengths the encoder uses — v1–40', () => {
    for (let version = 1; version <= 40; version += 1) {
      // The map reads only the function modules, which do not depend on the level.
      const matrix = QRCode.create('logo', { version, errorCorrectionLevel: 'M' }).modules
      for (const level of LEVELS) {
        const layout = codewordLayout(matrix, version, level)
        const where = `v${version}-${level}`
        expect(layout.totalCodewords, `${where} total`).toBe(Utils.getSymbolTotalCodewords(version))

        const modulesOf = new Uint16Array(layout.totalCodewords)
        let functionModules = 0
        let remainder = 0
        for (const codeword of layout.codewordAt) {
          if (codeword === FUNCTION_MODULE) functionModules += 1
          else if (codeword === REMAINDER_BIT) remainder += 1
          else modulesOf[codeword] = (modulesOf[codeword] ?? 0) + 1
        }
        expect(
          [...modulesOf].every((count) => count === 8),
          `${where}: a codeword that is not eight modules`,
        ).toBe(true)
        expect(remainder, `${where} remainder bits`).toBe(remainderBits(version))
        expect(functionModules + remainder + layout.totalCodewords * 8, `${where} every module accounted for`).toBe(
          matrix.size * matrix.size,
        )

        // Block lengths: equal error correction, data differing by at most one,
        // the longer blocks last, and together the whole symbol.
        const { blocks, ecCodewords } = errorCorrectionBlocks(version, level)
        const lengths = new Array<number>(blocks).fill(0)
        for (const block of layout.blockOf) lengths[block] = (lengths[block] ?? 0) + 1
        const dataLengths = lengths.map((length) => length - ecCodewords / blocks)
        expect(Math.max(...dataLengths) - Math.min(...dataLengths), `${where} data lengths`).toBeLessThanOrEqual(1)
        expect([...dataLengths].sort((a, b) => a - b), `${where} longer blocks last`).toEqual(dataLengths)
        expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(layout.totalCodewords)
        expect(layout.correctablePerBlock, `${where} t`).toBe(Math.floor(ecCodewords / blocks / 2))
      }
    }
  })

  /** A code drawn straight from the matrix, with every module of the listed codewords inverted. */
  function readsWithCorrupted(text: string, level: 'M' | 'Q' | 'H', codewords: readonly number[]): boolean {
    const qr = QRCode.create(text, { errorCorrectionLevel: level })
    const layout = codewordLayout(qr.modules, qr.version, level)
    const corrupted = new Set(codewords)
    const n = qr.modules.size
    const shapes: QrShape[] = [{ kind: 'rect', x: 0, y: 0, w: n + 8, h: n + 8, r: 0, fill: '#ffffff' }]
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        let dark = qr.modules.get(row, col) === 1
        const codeword = layout.codewordAt[row * n + col] ?? FUNCTION_MODULE
        if (codeword >= 0 && corrupted.has(codeword)) dark = !dark
        if (dark) shapes.push({ kind: 'rect', x: col + 4, y: row + 4, w: 1, h: 1, r: 0, fill: '#000000' })
      }
    }
    const image = rasterise({ size: n + 8, shapes, version: qr.version, errorCorrectionLevel: level }, 4)
    try {
      const source = new RGBLuminanceSource(image.luminance, image.width, image.height)
      return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(source)), HINTS).getText() === text
    } catch {
      return false
    }
  }

  const codewordsIn = (layout: CodewordLayout, block: number): number[] =>
    [...layout.blockOf.keys()].filter((index) => layout.blockOf[index] === block)

  it.each([
    // Two equal blocks; four equal blocks; four blocks of 15 and 16 data codewords.
    ['referral 66 B at M', REFERRAL_66, 'M', [5, 2, 12]],
    ['referral 74 B at Q', LOGO_LINKS[2]![1], 'Q', [6, 4, 12]],
    ['web ad 60 B at Q', LOGO_LINKS[4]![1], 'Q', [5, 4, 9]],
  ] as const)(
    'is the map the READER reads: %s — t errors in one block decode, t + 1 do not, 2t over two blocks do',
    (_label, text, level, [version, blocks, t]) => {
      const qr = QRCode.create(text, { errorCorrectionLevel: level })
      const layout = codewordLayout(qr.modules, qr.version, level)
      expect([qr.version, layout.blocks, layout.correctablePerBlock], 'precondition: the symbol').toEqual([
        version,
        blocks,
        t,
      ])
      const first = codewordsIn(layout, 0)
      const last = codewordsIn(layout, blocks - 1)

      expect(readsWithCorrupted(text, level, []), 'the untouched code').toBe(true)
      expect(readsWithCorrupted(text, level, first.slice(0, t)), 't in the first block').toBe(true)
      expect(readsWithCorrupted(text, level, last.slice(-t)), 't in the last block').toBe(true)
      // Errors, not erasures: one more wrong codeword than t, in ONE block, and
      // the reader gives up — whatever the modules were set to.
      expect(readsWithCorrupted(text, level, first.slice(0, t + 1)), 't + 1 in the first block').toBe(false)
      expect(readsWithCorrupted(text, level, last.slice(-(t + 1))), 't + 1 in the last block').toBe(false)
      // And the blocks really are separate: twice t, split, still reads.
      expect(readsWithCorrupted(text, level, [...first.slice(0, t), ...last.slice(0, t)]), '2t over two').toBe(true)
    },
  )
})

/* ────────────────────────────── the plan rules ─────────────────────────────── */

interface Candidate {
  readonly level: 'M' | 'Q' | 'H'
  readonly version: number
  readonly modules: number
  readonly knockout: number
  readonly pixelsPerModule: number
  readonly platePixels: number
  readonly budgetUse: number
}

/** Function modules inside a centred k × k, read off the encoder's own matrix. */
function functionModulesInside(matrix: { size: number; isReserved(r: number, c: number): number }, k: number): number {
  const from = (matrix.size - k) / 2
  let count = 0
  for (let row = from; row < from + k; row += 1) {
    for (let col = from; col < from + k; col += 1) if (matrix.isReserved(row, col)) count += 1
  }
  return count
}

/** Worst block's touched codewords over its t — computed from the map, not by `knockoutBudget`. */
function worstBlockUse(layout: CodewordLayout, k: number): number {
  const from = (layout.size - k) / 2
  const touched = new Set<number>()
  for (let row = from; row < from + k; row += 1) {
    for (let col = from; col < from + k; col += 1) {
      const codeword = layout.codewordAt[row * layout.size + col] ?? FUNCTION_MODULE
      if (codeword >= 0) touched.add(codeword)
    }
  }
  const perBlock = new Map<number, number>()
  for (const codeword of touched) {
    const block = layout.blockOf[codeword] ?? -1
    perBlock.set(block, (perBlock.get(block) ?? 0) + 1)
  }
  return Math.max(0, ...perBlock.values()) / layout.correctablePerBlock
}

/**
 * Every (level, knockout) the rules allow, by brute force — every odd width
 * from 7 up to the cap, at every level, with the rules as literals.
 */
function allowed(text: string, size: 'small' | 'large', px: number): Candidate[] {
  const out: Candidate[] = []
  for (const level of LOGO_LEVELS) {
    let qr: ReturnType<typeof QRCode.create>
    try {
      qr = QRCode.create(text, { errorCorrectionLevel: level })
    } catch {
      continue
    }
    const n = qr.modules.size
    const pixelsPerModule = px / (n + 8)
    if (pixelsPerModule < 4) continue
    const layout = codewordLayout(qr.modules, qr.version, level)
    const cap = Math.floor((n * (size === 'small' ? 20 : 30)) / 100)
    for (let k = 7; k <= cap; k += 2) {
      if (functionModulesInside(qr.modules, k) > 0) continue
      const budgetUse = worstBlockUse(layout, k)
      if (budgetUse > 0.5) continue
      out.push({ level, version: qr.version, modules: n, knockout: k, pixelsPerModule, platePixels: k * pixelsPerModule, budgetUse })
    }
  }
  return out
}

function bestOf(candidates: readonly Candidate[]): Candidate | null {
  const order = (a: Candidate, b: Candidate): number =>
    b.platePixels - a.platePixels || b.pixelsPerModule - a.pixelsPerModule || a.budgetUse - b.budgetUse
  return [...candidates].sort(order)[0] ?? null
}

const summary = (plan: Pick<QrLogoPlan, 'level' | 'version' | 'knockout'> | null): string =>
  plan === null ? 'no logo' : `${plan.level} v${plan.version} k=${plan.knockout}`

describe('planQrLogo', () => {
  // The sizes a code is shown at, and 160 px: between them, the realistic
  // links never land between 3 and 4 px per module, so without a size where
  // the floor BINDS a planner holding modules to 3 px passed this whole sweep.
  const SIZES = [96, 120, 160, 208, 256] as const

  it('is swept at every size a code is shown at, the dialogs included', () => {
    for (const px of Object.values(LOGO_DISPLAY_PIXELS)) expect(SIZES).toContain(px)
  })

  it('returns only plans that keep every rule, and always the best the rules allow — every realistic link, size and cap', () => {
    let plans = 0
    for (const [label, text] of LOGO_LINKS) {
      for (const px of SIZES) {
        for (const size of ['small', 'large'] as const) {
          const where = `${label} at ${px} px, ${size}`
          const plan = planQrLogo(text, withLogo(size), px)
          const best = bestOf(allowed(text, size, px))
          expect(summary(plan), `${where}: not the best plan the rules allow`).toBe(summary(best))
          if (plan === null) continue
          plans += 1

          const qr = QRCode.create(text, { errorCorrectionLevel: plan.level })
          const n = qr.modules.size
          expect([plan.version, plan.modules], `${where}: the symbol`).toEqual([qr.version, n])
          expect(plan.knockout % 2, `${where}: an even knockout cannot be centred`).toBe(1)
          expect(plan.knockout, `${where}: under the 7-module minimum`).toBeGreaterThanOrEqual(7)
          expect(plan.knockout, `${where}: over the cap`).toBeLessThanOrEqual(
            Math.floor((n * (size === 'small' ? 20 : 30)) / 100),
          )
          expect(px / (n + 8), `${where}: modules under 4 CSS px`).toBeGreaterThanOrEqual(4)
          expect(plan.pixelsPerModule).toBeCloseTo(px / (n + 8), 9)
          expect(plan.platePixels).toBeCloseTo(plan.knockout * (px / (n + 8)), 9)
          expect(functionModulesInside(qr.modules, plan.knockout), `${where}: a function module knocked out`).toBe(0)
          const use = worstBlockUse(codewordLayout(qr.modules, qr.version, plan.level), plan.knockout)
          expect(use, `${where}: spends more than half the worst block's correction`).toBeLessThanOrEqual(0.5)
          expect(plan.budgetUse).toBeCloseTo(use, 9)
        }
      }
    }
    // Anti-vacuous anchor: the sweep above judged real plans, not only nulls.
    expect(plans).toBeGreaterThan(40)
  })

  it('never plans a logo at 96 or 120 px — no symbol reaches 4 px per module there', () => {
    // The smallest symbol, version 1, is 21 modules and a 4-module quiet zone
    // each side: 29 × 4 = 116 px before any logo is possible, and a logo needs
    // version 2 (133 px) or, small, version 5 (180 px).
    for (const [label, text] of LOGO_LINKS) {
      for (const px of [96, 120]) {
        for (const size of ['small', 'large'] as const) {
          expect(planQrLogo(text, withLogo(size), px), `${label} at ${px} px, ${size}`).toBeNull()
        }
      }
    }
    expect(planQrLogo('https://t.me/a', withLogo('large'), 115)).toBeNull()
  })

  it('holds modules to 4 CSS px exactly — a plan at 4.00 px per module, and none a pixel smaller', () => {
    // The 66-byte referral link is version 5 at M: 37 modules and an 8-module
    // quiet zone, so 180 px is 4.00 px per module and 179 px is 3.98.
    expect(summary(planQrLogo(REFERRAL_66, withLogo('small'), 180))).toBe('M v5 k=7')
    expect(planQrLogo(REFERRAL_66, withLogo('small'), 179)).toBeNull()
    expect(planQrLogo(REFERRAL_66, withLogo('large'), 179)).toBeNull()
  })

  it('reproduces the research numbers on the links they were measured on', () => {
    const plan = (text: string, size: 'small' | 'large', px: number) => {
      const p = planQrLogo(text, withLogo(size), px)
      return p === null ? null : { ...p, pixelsPerModule: round2(p.pixelsPerModule), platePixels: round1(p.platePixels), budgetUse: round2(p.budgetUse) }
    }
    const round1 = (value: number): number => Math.round(value * 10) / 10
    const round2 = (value: number): number => Math.round(value * 100) / 100

    expect(plan(REFERRAL_66, 'small', 208)).toEqual({
      level: 'M', version: 5, modules: 37, knockout: 7, pixelsPerModule: 4.62, platePixels: 32.4, budgetUse: 0.5,
    })
    expect(plan(REFERRAL_66, 'large', 208)).toEqual({
      level: 'Q', version: 6, modules: 41, knockout: 11, pixelsPerModule: 4.24, platePixels: 46.7, budgetUse: 0.5,
    })
    const byLabel = new Map(LOGO_LINKS)
    // The longest web ad link (v5) and the UTM link (v6) in the enlarged partner dialog.
    expect(summary(planQrLogo(byLabel.get('web ad 77 B')!, withLogo('large'), 256))).toBe('M v5 k=7')
    expect(plan(byLabel.get('web ad + UTM 92 B')!, 'large', 256)).toMatchObject({
      level: 'M', version: 6, knockout: 7, pixelsPerModule: 5.22,
    })
    // A short bot link goes UP two versions to H for a larger plate.
    expect(summary(planQrLogo(byLabel.get('bot ad 38 B')!, withLogo('large'), 208))).toBe('H v5 k=9')
  })

  it('gives no logo where every level puts an alignment pattern on the centre', () => {
    // 130 bytes: M v8, Q v9, H v11 — each with an alignment pattern at the
    // centre. 320 px is ample for the modules; the knockout is what cannot be.
    const text = `https://cabinet.example.com/register?ref=${'a1b2c3d4e5'.repeat(8)}${'x'.repeat(9)}`
    expect(text).toHaveLength(130)
    const versions: number[] = []
    for (const level of LOGO_LEVELS) {
      const qr = QRCode.create(text, { errorCorrectionLevel: level })
      versions.push(qr.version)
      expect(320 / (qr.modules.size + 8), `precondition: ${level} is large enough`).toBeGreaterThanOrEqual(4)
      expect(knockoutIsClear(qr.modules, 7), `precondition: ${level} v${qr.version} has a clear centre`).toBe(false)
    }
    expect(versions).toEqual([8, 9, 11])
    expect(planQrLogo(text, withLogo('large'), 320)).toBeNull()
  })

  it('has no plan without a logo, a size, or a text', () => {
    expect(planQrLogo(REFERRAL_66, QR_STYLE_PLAIN, 208)).toBeNull()
    for (const px of [0, -208, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planQrLogo(REFERRAL_66, withLogo('large'), px), String(px)).toBeNull()
    }
    expect(planQrLogo('', withLogo('large'), 208)).toBeNull()
    // A size a hand-built style could carry past the type.
    expect(planQrLogo(REFERRAL_66, { ...QR_STYLE_PLAIN, logo: { src: '/uploads/branding/l.png', size: 'huge' as 'large', plate: 'light' } }, 208)).toBeNull()
  })

  it('does not care which plate the logo sits on — the knockout is the same', () => {
    expect(planQrLogo(REFERRAL_66, withLogo('large', 'dark'), 208)).toEqual(
      planQrLogo(REFERRAL_66, withLogo('large', 'light'), 208),
    )
  })
})

describe('knockoutBudget and knockoutIsClear', () => {
  const qr = QRCode.create(REFERRAL_66, { errorCorrectionLevel: 'M' })
  const layout = codewordLayout(qr.modules, qr.version, 'M')

  it('count what a knockout spends, and refuse one with a function module in it', () => {
    expect(knockoutBudget(layout, 7)?.budgetUse).toBe(0.5)
    // The oversized knockout the decode test must see fail: beyond what the worst block corrects.
    expect(knockoutBudget(layout, 13)?.budgetUse).toBeGreaterThan(1)
    expect(knockoutBudget(layout, 8)).toBeNull()
    expect(knockoutBudget(layout, 39)).toBeNull()
    // The whole symbol holds the finders.
    expect(knockoutBudget(layout, 37)).toBeNull()
    expect(knockoutIsClear(qr.modules, 37)).toBe(false)
    expect(knockoutIsClear(qr.modules, 11)).toBe(true)
    expect(knockoutIsClear(qr.modules, 10)).toBe(false)
  })
})

describe('the rule constants', () => {
  it('are the numbers the rules are argued and measured with', () => {
    expect(LOGO_MIN_PIXELS_PER_MODULE).toBe(4)
    // "The same floor as dots" — one number, stated twice, held together.
    expect(MIN_PIXELS_PER_MODULE_FOR_DOTS).toBe(4)
    expect(LOGO_MAX_BUDGET_USE).toBe(0.5)
    expect(LOGO_MIN_KNOCKOUT).toBe(7)
    expect(LOGO_MOAT_MODULES).toBe(1)
    expect(LOGO_MAX_WIDTH_PERCENT).toEqual({ small: 20, large: 30 })
    expect(LOGO_DISPLAY_PIXELS).toEqual({ referralInvite: 208, partnerEnlarged: 256 })
  })

  it('put the enlarged partner code at 4 px per module or more on the longest partner link', () => {
    // 256 px over v5 (the 64–77-byte web ad) and v6 (the 92-byte UTM link).
    const byLabel = new Map(LOGO_LINKS)
    for (const label of ['web ad 77 B', 'web ad + UTM 92 B', 'bot ad 65 B']) {
      const n = QRCode.create(byLabel.get(label)!, { errorCorrectionLevel: 'M' }).modules.size
      expect(256 / (n + 8), label).toBeGreaterThanOrEqual(5.2)
    }
  })
})
