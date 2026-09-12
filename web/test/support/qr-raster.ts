/**
 * Pixels from a `QrDrawing`, for tests that must READ a styled code back.
 *
 * This walks the SAME shape list `qrDrawingToSvg` serialises — rect by rect,
 * circle by circle, in the same paint order — so a code that decodes here is the
 * geometry the page draws. What it does not model is the browser's own
 * anti-aliasing; each pixel is sampled at its centre, which is the harsher of
 * the two for thin features, not the kinder.
 */
import type { QrDrawing, QrShape } from '@/lib/qr-style'

/** Does this shape cover the point? Units are modules; rounded corners honoured. */
export function covers(shape: QrShape, px: number, py: number): boolean {
  if (shape.kind === 'circle') {
    return (px - shape.cx) ** 2 + (py - shape.cy) ** 2 <= shape.r ** 2
  }
  if (px < shape.x || px > shape.x + shape.w || py < shape.y || py > shape.y + shape.h) {
    return false
  }
  const r = shape.r
  if (r <= 0) return true
  // Nearest point of the inner rectangle whose corners are the arc centres.
  const nx = Math.min(Math.max(px, shape.x + r), shape.x + shape.w - r)
  const ny = Math.min(Math.max(py, shape.y + r), shape.y + shape.h - r)
  return (px - nx) ** 2 + (py - ny) ** 2 <= r ** 2
}

/** The colour painted at a point — later shapes win, as they do in the SVG. */
export function paintAt(drawing: QrDrawing, px: number, py: number): string | null {
  let colour: string | null = null
  for (const shape of drawing.shapes) {
    if (covers(shape, px, py)) colour = shape.fill
  }
  return colour
}

export interface LuminanceImage {
  readonly width: number
  readonly height: number
  /** One byte per pixel, 0 = black, 255 = white. */
  readonly luminance: Uint8ClampedArray
}

/**
 * Rasterise a drawing at `pixelsPerModule`, sampling every pixel at its centre.
 *
 * Shape by shape, each over its own bounding box, in paint order — not pixel by
 * pixel over every shape. The second is what `paintAt` does and is right for a
 * few dozen probes; over a whole subscription code it is a hundred million
 * coverage tests. The answer is identical because later shapes still win.
 */
export function rasterise(drawing: QrDrawing, pixelsPerModule: number): LuminanceImage {
  const side = Math.round(drawing.size * pixelsPerModule)
  const luminance = new Uint8ClampedArray(side * side).fill(255)
  for (const shape of drawing.shapes) {
    const value = luma(shape.fill)
    const [x0, y0, x1, y1] = bounds(shape)
    const px0 = Math.max(0, Math.floor(x0 * pixelsPerModule))
    const py0 = Math.max(0, Math.floor(y0 * pixelsPerModule))
    const px1 = Math.min(side, Math.ceil(x1 * pixelsPerModule))
    const py1 = Math.min(side, Math.ceil(y1 * pixelsPerModule))
    for (let y = py0; y < py1; y += 1) {
      for (let x = px0; x < px1; x += 1) {
        if (covers(shape, (x + 0.5) / pixelsPerModule, (y + 0.5) / pixelsPerModule)) {
          luminance[y * side + x] = value
        }
      }
    }
  }
  return { width: side, height: side, luminance }
}

function bounds(shape: QrShape): [number, number, number, number] {
  return shape.kind === 'circle'
    ? [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r]
    : [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
}

/**
 * Pixels as a CAMERA records them — which is what makes a styled code's fill
 * matter at all.
 *
 * `rasterise` samples each pixel at one point, on a grid that lines up exactly
 * with the modules. Under that, a dot a quarter of a module wide decodes
 * perfectly, because the reader's centre sample lands squarely on it. That was
 * MEASURED, not guessed: shrinking the dots to radius 0.12 left every
 * point-sampled decode case green. A sensor does three things this adds:
 *
 *   - it INTEGRATES light over each pixel (supersampled, then averaged), so a
 *     pixel a dot only partly covers reads grey, not black;
 *   - its grid does not line up with the code's — pass a fractional
 *     `pixelsPerModule` and the modules straddle pixels unevenly;
 *   - it is slightly out of focus: a box blur about 0.6 of a module wide.
 *
 * Under that, a shape reads dark only if it keeps the middle of its module dark
 * — full squares, rounded squares and dots of diameter 0.86 do; a 0.24 dot does
 * not.
 */
export function rasteriseCamera(
  drawing: QrDrawing,
  pixelsPerModule: number,
  options: { readonly supersample?: number; readonly blurModules?: number } = {},
): LuminanceImage {
  const supersample = options.supersample ?? 4
  const side = Math.round(drawing.size * pixelsPerModule)
  const fineSide = side * supersample
  const fineScale = fineSide / drawing.size
  const fine = new Uint8ClampedArray(fineSide * fineSide).fill(255)

  for (const shape of drawing.shapes) {
    // The white field is what the buffer already holds; painting it pixel by
    // pixel would be most of the work for no change.
    const isField =
      shape.kind === 'rect' &&
      shape.x === 0 &&
      shape.y === 0 &&
      shape.w === drawing.size &&
      shape.fill === '#ffffff'
    if (isField) continue
    const value = luma(shape.fill)
    const [x0, y0, x1, y1] = bounds(shape)
    const px0 = Math.max(0, Math.floor(x0 * fineScale))
    const py0 = Math.max(0, Math.floor(y0 * fineScale))
    const px1 = Math.min(fineSide, Math.ceil(x1 * fineScale))
    const py1 = Math.min(fineSide, Math.ceil(y1 * fineScale))
    for (let y = py0; y < py1; y += 1) {
      for (let x = px0; x < px1; x += 1) {
        if (covers(shape, (x + 0.5) / fineScale, (y + 0.5) / fineScale)) {
          fine[y * fineSide + x] = value
        }
      }
    }
  }

  const luminance = new Uint8ClampedArray(side * side)
  const area = supersample * supersample
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      let sum = 0
      for (let dy = 0; dy < supersample; dy += 1) {
        for (let dx = 0; dx < supersample; dx += 1) {
          sum += fine[(y * supersample + dy) * fineSide + (x * supersample + dx)] ?? 255
        }
      }
      luminance[y * side + x] = Math.round(sum / area)
    }
  }

  const windowModules = options.blurModules ?? 0.6
  const radius = Math.max(1, Math.round((windowModules * pixelsPerModule) / 2))
  return blur({ width: side, height: side, luminance }, radius)
}

/** A box blur of the given radius — a stand-in for a camera slightly out of focus. */
export function blur(image: LuminanceImage, radius: number): LuminanceImage {
  if (radius <= 0) return image
  const { width, height, luminance } = image
  const out = new Uint8ClampedArray(luminance.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx
          const sy = y + dy
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
          sum += luminance[sy * width + sx] ?? 255
          count += 1
        }
      }
      out[y * width + x] = Math.round(sum / count)
    }
  }
  return { width, height, luminance: out }
}

/** Rec. 601 luma of a `#rrggbb` / `#rgb` colour, 0..255. */
export function luma(hex: string): number {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6)
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b)
}
