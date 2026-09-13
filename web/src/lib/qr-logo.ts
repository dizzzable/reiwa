/**
 * A logo in the middle of a styled QR code: whether one fits at the size the
 * code is shown, and how large it may be. Pure — no DOM, no network — so the
 * panel runs this very file (vendored by `scripts/sync-landing-kit.mjs --kit qr`)
 * to plan and verify an operator's logo before it is saved.
 *
 * ── What a logo costs, and why "blank modules are free" is wrong ────────────
 *
 * A logo covers modules, and a covered module reads as whatever the logo is at
 * that point. The reader cannot tell it from a damaged one. ZXing — the reader
 * family v2rayNG embeds, and the one `qr-style-decodes.test.ts` holds every code
 * to — corrects ERRORS only. Its Reed–Solomon decoder is
 * `ReedSolomonDecoder.decode(received, twoS)`: the received codewords and the
 * number of error-correction codewords, and no list of erasure positions at all
 * (`@zxing/library` `core/common/reedsolomon/ReedSolomonDecoder`; the QR decoder
 * calls it from `Decoder.correctErrors` with exactly those two arguments). So a
 * knocked-out codeword costs what a wrong one costs — one whole unit of the
 * t = ⌊EC/2⌋ errors its block can correct — and clearing the modules under a
 * logo buys a clean picture, not a discount. The half-price case, an erasure
 * whose position the decoder is TOLD, does not exist on the reading side.
 *
 * And the unit of damage is the CODEWORD, not the module. A codeword is eight
 * modules laid in a two-column zigzag, so a knockout spends every codeword it
 * so much as grazes. That is why this plans from an exact placement map — which
 * module belongs to which codeword, which codeword to which block — rather than
 * from an area percentage: the famous 7/15/25/30% are shares of codewords, and
 * the budget runs out block by block, not symbol-wide.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   1. A CENTRED, ODD k × k knockout of whole modules, aligned to the grid.
 *      The centre is the safe place: timing runs along row and column 6 and
 *      format information sits by the finders, both at the edges.
 *   2. NO FUNCTION MODULE inside it. From version 7 an alignment pattern sits
 *      exactly on the centre, and those versions simply get no logo.
 *   3. THE WORST BLOCK spends at most HALF its correction capacity on touched
 *      codewords. The other half is the camera's: blur, glare, a crease. No
 *      decode test can see this margin — its image models are noise-free, and
 *      on realistic links the width cap alone keeps the worst block within its
 *      capacity (measured by raising this to 1.5: every sweep case still read)
 *      — so `qr-logo-plan.test.ts` pins it by recomputation instead.
 *   4. AT LEAST 4 CSS PIXELS PER MODULE at the size the code is shown — the
 *      floor dots step down at (`MIN_PIXELS_PER_MODULE_FOR_DOTS`). CSS pixels,
 *      as there: they track the physical size a camera sees. At 96 px no
 *      symbol reaches it (the smallest needs 116 px), so the partner block's
 *      thumbnails can never carry a logo.
 *   5. k ≥ 7, with a ONE-MODULE LIGHT MOAT inside the knockout between the
 *      surrounding modules and the plate, so the mark never touches data.
 *   6. A CAP on width: `small` ≤ 20%, `large` ≤ 30% of the symbol.
 *   7. Levels M, Q and H are each tried, and the plan with the LARGEST PLATE IN
 *      CSS PIXELS wins (ties: larger modules, then less of the budget used). A
 *      higher level can buy a larger knockout at the price of a larger symbol
 *      and smaller modules; judging in pixels is what weighs the two. No
 *      candidate satisfying every rule → `null`, and the code is drawn without
 *      a logo, exactly as it would be without one configured.
 *
 * Measured on the links the cabinet draws (research lab, 13.09.2026): a
 * 66–74-byte referral link at 208 px plans `small` as M v5 k = 7 (32 px) and
 * `large` as Q v6 k = 11 (47 px).
 *
 * ── What geometry cannot promise ────────────────────────────────────────────
 *
 * A mark shaped like a finder — a QR "eye", a bullseye — can be mistaken for a
 * fourth finder pattern, and ZXing then picks the wrong three. Where the plate
 * can hold one at the module pitch (k ≥ 9), such a mark does not decode under
 * ANY plan, and nothing about the knockout can rule it out, because it depends
 * on the picture, not on its size.
 *
 * The same failure has a quieter form, and it depends on the LINK as well as
 * the picture. ZXing's finder test accepts runs within 50% of 1:1:3:1:1, and
 * the one-module moat is exactly a finder's light ring: a dark edge next to it
 * — a thin ring round a light interior, a light image filling the dark plate,
 * or a solid five-module core — is half a cross-section, and where the link's
 * own modules happen to supply the other half ZXing confirms a false finder
 * and drops a real one (measured: a bare dark plate read as a finder of 1.28
 * modules, confirmed on six rows). Over 300 random realistic links at 208 and
 * 256 px that broke 1 to 10 codes in 1 200 per mark model — and MENDED 5 to 7,
 * against 49 in 1 200 the same codes fail with no logo at all. So a panel check
 * on one sample link cannot vouch for every subscriber's link; it can only
 * catch a picture that fails often. `qr-logo-decodes.test.ts` pins both forms
 * as failing, so the class stays visible.
 */
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode'

import { QUIET_ZONE_MODULES } from './qr-options'
import type { QrLogoSize, QrStyle } from './qr-style'

/** The levels a logo is planned at. `L` is never tried: it has nothing to spend. */
export type QrLogoLevel = 'M' | 'Q' | 'H'
export const LOGO_LEVELS: readonly QrLogoLevel[] = ['M', 'Q', 'H']

/** Rule 4 — the same floor as `MIN_PIXELS_PER_MODULE_FOR_DOTS` in `qr-style`. */
export const LOGO_MIN_PIXELS_PER_MODULE = 4
/** Rule 3 — the share of the worst block's correction capacity a logo may spend. */
export const LOGO_MAX_BUDGET_USE = 0.5
/** Rule 5 — the smallest knockout, in modules: a 5 × 5 plate inside a one-module moat. */
export const LOGO_MIN_KNOCKOUT = 7
/** Rule 5 — the light ring, in modules, between the surrounding modules and the plate. */
export const LOGO_MOAT_MODULES = 1
/** Rule 6 — the widest knockout, in whole percent of the symbol's width. */
export const LOGO_MAX_WIDTH_PERCENT: Readonly<Record<QrLogoSize, number>> = { small: 20, large: 30 }

/**
 * The CSS sizes the cabinet shows a logo-bearing code at. Exported from the kit
 * so the panel verifies an operator's logo at exactly these sizes, and a dialog
 * that grows here changes what the panel checks instead of drifting from it.
 */
export const LOGO_DISPLAY_PIXELS = {
  /** The referral invite's dialog (`invite-link-hero.tsx`). */
  referralInvite: 208,
  /** A partner's advertising code, tapped open (`partner-qr-dialog.tsx`). */
  partnerEnlarged: 256,
} as const

export interface QrLogoPlan {
  readonly level: QrLogoLevel
  readonly version: number
  /** Modules across the symbol, quiet zone excluded. */
  readonly modules: number
  /** Width of the centred knockout, in modules. Odd, ≥ `LOGO_MIN_KNOCKOUT`. */
  readonly knockout: number
  /** CSS pixels per module at the size the plan was made for. */
  readonly pixelsPerModule: number
  /** `knockout × pixelsPerModule` — what the planner maximises. */
  readonly platePixels: number
  /** Codewords the knockout touches in its worst block, over what that block corrects. */
  readonly budgetUse: number
}

/**
 * The plan for drawing `style.logo` on `text` shown at `displayPixels` CSS px,
 * or `null` when no plan satisfies every rule in the header — including when
 * the style has no logo, or the size is not a positive number.
 */
export function planQrLogo(text: string, style: QrStyle, displayPixels: number): QrLogoPlan | null {
  const logo = style.logo
  if (logo === null || !Number.isFinite(displayPixels) || displayPixels <= 0) return null
  const widthPercent: number | undefined = LOGO_MAX_WIDTH_PERCENT[logo.size]
  if (widthPercent === undefined) return null

  let best: QrLogoPlan | null = null
  for (const level of LOGO_LEVELS) {
    let qr: ReturnType<typeof QRCode.create>
    try {
      qr = QRCode.create(text, { errorCorrectionLevel: level })
    } catch {
      // Too long for this level — and so for every higher one.
      break
    }
    const matrix = qr.modules
    const pixelsPerModule = displayPixels / (matrix.size + QUIET_ZONE_MODULES * 2)
    // A higher level never fits the same text in a SMALLER symbol, so once the
    // modules are too small here they are too small at every level after it.
    if (pixelsPerModule < LOGO_MIN_PIXELS_PER_MODULE) break

    const layout = codewordLayout(matrix, qr.version, level)
    const widest = largestOddAtMost(Math.floor((matrix.size * widthPercent) / 100))
    for (let knockout = widest; knockout >= LOGO_MIN_KNOCKOUT; knockout -= 2) {
      const budget = knockoutBudget(layout, knockout)
      // A function module inside (null) may clear at a narrower knockout, and
      // an over-budget one certainly spends less there: keep narrowing.
      if (budget === null || budget.budgetUse > LOGO_MAX_BUDGET_USE) continue
      const plan: QrLogoPlan = {
        level,
        version: qr.version,
        modules: matrix.size,
        knockout,
        pixelsPerModule,
        platePixels: knockout * pixelsPerModule,
        budgetUse: budget.budgetUse,
      }
      if (best === null || isBetterPlan(plan, best)) best = plan
      break
    }
  }
  return best
}

/* ───────────────────────── the codeword placement map ──────────────────────── */

/** The shape of `qrcode`'s matrix this file reads: its size and which modules are function modules. */
export interface QrMatrixLike {
  readonly size: number
  isReserved(row: number, col: number): number | boolean
}

/** `codewordAt` value of a function module. */
export const FUNCTION_MODULE = -1
/** `codewordAt` value of a remainder bit: placed after the last codeword, part of none. */
export const REMAINDER_BIT = -2

export interface CodewordLayout {
  /** Modules across, as the matrix. */
  readonly size: number
  /**
   * For every module, row-major: the index of the codeword it carries, in the
   * INTERLEAVED order codewords are placed in — or `FUNCTION_MODULE` /
   * `REMAINDER_BIT`.
   */
  readonly codewordAt: Int32Array
  readonly totalCodewords: number
  readonly blocks: number
  /** The block each interleaved codeword belongs to. */
  readonly blockOf: Uint8Array
  /** Error-correction codewords in every block (the same for all of them). */
  readonly ecCodewordsPerBlock: number
  /** Errors — not erasures — each block's Reed–Solomon code corrects: ⌊EC / 2⌋. */
  readonly correctablePerBlock: number
}

/**
 * Which codeword, and which block, every module of `matrix` belongs to.
 *
 * Placement is ISO/IEC 18004 §7.7.3, as `qrcode` writes it (`setupData`) and
 * ZXing reads it back (`BitMatrixParser.readCodewords`): two-module-wide columns
 * from the right, zigzagging up and down, the vertical timing column skipped
 * whole, every function module passed over. Bits are counted off in that order,
 * eight to a codeword. Data codewords are interleaved block by block, the
 * shorter blocks first; then error-correction codewords the same way.
 *
 * Only the reserved modules are read, never the dark ones — so the map is the
 * same for every text of a given version and level.
 */
export function codewordLayout(
  matrix: QrMatrixLike,
  version: number,
  level: QRCodeErrorCorrectionLevel,
): CodewordLayout {
  const size = matrix.size
  let capacityBits = 0
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!matrix.isReserved(row, col)) capacityBits += 1
    }
  }
  // Remainder bits number 0, 3, 4 or 7 — always fewer than a codeword.
  const totalCodewords = Math.floor(capacityBits / 8)

  const codewordAt = new Int32Array(size * size).fill(FUNCTION_MODULE)
  let upward = true
  let bit = 0
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let offset = 0; offset < 2; offset += 1) {
        if (matrix.isReserved(row, col - offset)) continue
        const codeword = Math.floor(bit / 8)
        codewordAt[row * size + col - offset] = codeword < totalCodewords ? codeword : REMAINDER_BIT
        bit += 1
      }
    }
    upward = !upward
  }

  const { blocks, ecCodewords } = errorCorrectionBlocks(version, level)
  const ecCodewordsPerBlock = ecCodewords / blocks
  const dataCodewords = totalCodewords - ecCodewords
  const shortData = Math.floor(dataCodewords / blocks)
  // The LAST `longBlocks` blocks carry one more data codeword each.
  const longBlocks = dataCodewords % blocks
  const blockOf = new Uint8Array(totalCodewords)
  let index = 0
  for (let i = 0; i <= shortData; i += 1) {
    for (let block = 0; block < blocks; block += 1) {
      const length = block < blocks - longBlocks ? shortData : shortData + 1
      if (i < length) blockOf[index++] = block
    }
  }
  for (let i = 0; i < ecCodewordsPerBlock; i += 1) {
    for (let block = 0; block < blocks; block += 1) blockOf[index++] = block
  }

  return {
    size,
    codewordAt,
    totalCodewords,
    blocks,
    blockOf,
    ecCodewordsPerBlock,
    correctablePerBlock: Math.floor(ecCodewordsPerBlock / 2),
  }
}

export interface KnockoutBudget {
  /** Distinct codewords with at least one module inside the knockout. */
  readonly touchedCodewords: number
  /** The most of them that fall in any one block. */
  readonly worstBlockCodewords: number
  /** `worstBlockCodewords / correctablePerBlock`. Above 1 the symbol cannot be read. */
  readonly budgetUse: number
}

/**
 * What a centred `knockout × knockout` spends, or `null` when it contains a
 * function module — those are not covered by Reed–Solomon at all, and knocking
 * one out is not a cost but a different symbol.
 */
export function knockoutBudget(layout: CodewordLayout, knockout: number): KnockoutBudget | null {
  const { size } = layout
  if (!isCentredKnockout(size, knockout)) return null
  const from = (size - knockout) / 2
  const touched = new Uint8Array(layout.totalCodewords)
  const perBlock = new Uint32Array(layout.blocks)
  let touchedCodewords = 0
  for (let row = from; row < from + knockout; row += 1) {
    for (let col = from; col < from + knockout; col += 1) {
      const codeword = layout.codewordAt[row * size + col] ?? FUNCTION_MODULE
      if (codeword === FUNCTION_MODULE) return null
      if (codeword === REMAINDER_BIT || touched[codeword] === 1) continue
      touched[codeword] = 1
      touchedCodewords += 1
      perBlock[layout.blockOf[codeword] ?? 0] += 1
    }
  }
  const worstBlockCodewords = perBlock.reduce((worst, count) => Math.max(worst, count), 0)
  return {
    touchedCodewords,
    worstBlockCodewords,
    budgetUse: worstBlockCodewords / layout.correctablePerBlock,
  }
}

/**
 * True when a centred `knockout × knockout` fits `matrix` and holds no
 * function module. The renderer asks this of every plan it is handed, so a
 * plan made for another text or level can never clear a finder, a timing
 * module or an alignment pattern.
 */
export function knockoutIsClear(matrix: QrMatrixLike, knockout: number): boolean {
  const size = matrix.size
  if (!isCentredKnockout(size, knockout)) return false
  const from = (size - knockout) / 2
  for (let row = from; row < from + knockout; row += 1) {
    for (let col = from; col < from + knockout; col += 1) {
      if (matrix.isReserved(row, col)) return false
    }
  }
  return true
}

/* ──────────────────────── the error-correction block table ─────────────────── */

/**
 * ISO/IEC 18004:2015 Table 9, per version 1–40 and level L, M, Q, H: the number
 * of error-correction blocks, and the error-correction codewords in all of them
 * together. A local copy on purpose — `qrcode` does not export its own from the
 * package entry — and `qr-logo-plan.test.ts` holds it equal, entry for entry, to
 * both `qrcode`'s (`lib/core/error-correction-code`) and ZXing's
 * (`QRCodeVersion.getECBlocksForLevel`): the encoder that lays the blocks out
 * and the reader that corrects them.
 */
// prettier-ignore
const EC_BLOCKS: readonly number[] = [
  // L  M  Q  H
  1, 1, 1, 1,     1, 1, 1, 1,     1, 1, 2, 2,     1, 2, 2, 4,     1, 2, 4, 4,
  2, 4, 4, 4,     2, 4, 6, 5,     2, 4, 6, 6,     2, 5, 8, 8,     4, 5, 8, 8,
  4, 5, 8, 11,    4, 8, 10, 11,   4, 9, 12, 16,   4, 9, 16, 16,   6, 10, 12, 18,
  6, 10, 17, 16,  6, 11, 16, 19,  6, 13, 18, 21,  7, 14, 21, 25,  8, 16, 20, 25,
  8, 17, 23, 25,  9, 17, 23, 34,  9, 18, 25, 30,  10, 20, 27, 32, 12, 21, 29, 35,
  12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48,
  16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63,
  20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
]

// prettier-ignore
const EC_CODEWORDS: readonly number[] = [
  // L    M     Q     H
  7, 10, 13, 17,         10, 16, 22, 28,        15, 26, 36, 44,        20, 36, 52, 64,
  26, 48, 72, 88,        36, 64, 96, 112,       40, 72, 108, 130,      48, 88, 132, 156,
  60, 110, 160, 192,     72, 130, 192, 224,     80, 150, 224, 264,     96, 176, 260, 308,
  104, 198, 288, 352,    120, 216, 320, 384,    132, 240, 360, 432,    144, 280, 408, 480,
  168, 308, 448, 532,    180, 338, 504, 588,    196, 364, 546, 650,    224, 416, 600, 700,
  224, 442, 644, 750,    252, 476, 690, 816,    270, 504, 750, 900,    300, 560, 810, 960,
  312, 588, 870, 1050,   336, 644, 952, 1110,   360, 700, 1020, 1200,  390, 728, 1050, 1260,
  420, 784, 1140, 1350,  450, 812, 1200, 1440,  480, 868, 1290, 1530,  510, 924, 1350, 1620,
  540, 980, 1440, 1710,  570, 1036, 1530, 1800, 570, 1064, 1590, 1890, 600, 1120, 1680, 1980,
  630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
]

const LEVEL_COLUMN: Readonly<Record<string, number>> = { L: 0, M: 1, Q: 2, H: 3 }

/** Blocks and total error-correction codewords for a version (1–40) and level. */
export function errorCorrectionBlocks(
  version: number,
  level: QRCodeErrorCorrectionLevel,
): { readonly blocks: number; readonly ecCodewords: number } {
  const column = LEVEL_COLUMN[normalizeLevel(level)]
  if (!Number.isInteger(version) || version < 1 || version > 40 || column === undefined) {
    throw new RangeError(`no QR error-correction blocks for version ${version} at level ${level}`)
  }
  const at = (version - 1) * 4 + column
  return { blocks: EC_BLOCKS[at] ?? 0, ecCodewords: EC_CODEWORDS[at] ?? 0 }
}

/* ─────────────────────────────────── helpers ───────────────────────────────── */

/** `qrcode` accepts the long spellings too; the table is keyed by the letter. */
function normalizeLevel(level: QRCodeErrorCorrectionLevel): string {
  switch (level) {
    case 'low':
      return 'L'
    case 'medium':
      return 'M'
    case 'quartile':
      return 'Q'
    case 'high':
      return 'H'
    default:
      return level
  }
}

function isCentredKnockout(size: number, knockout: number): boolean {
  return Number.isInteger(knockout) && knockout > 0 && knockout % 2 === 1 && knockout <= size && size % 2 === 1
}

function largestOddAtMost(value: number): number {
  return value % 2 === 1 ? value : value - 1
}

const PLAN_EPSILON = 1e-9

/** Larger plate in CSS px; then larger modules; then less of the budget spent. */
function isBetterPlan(candidate: QrLogoPlan, incumbent: QrLogoPlan): boolean {
  if (Math.abs(candidate.platePixels - incumbent.platePixels) > PLAN_EPSILON) {
    return candidate.platePixels > incumbent.platePixels
  }
  if (Math.abs(candidate.pixelsPerModule - incumbent.pixelsPerModule) > PLAN_EPSILON) {
    return candidate.pixelsPerModule > incumbent.pixelsPerModule
  }
  return candidate.budgetUse < incumbent.budgetUse
}
