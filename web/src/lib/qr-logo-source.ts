/**
 * An operator's QR logo, from the upload to the `data:` URI the renderer may
 * write into a code (`qrSvg`'s `logoHref`).
 *
 * ── Why inline, and why only this ───────────────────────────────────────────
 *
 * A code reaches the page as an SVG inside an `<img>`, and an SVG used as an
 * image loads nothing from outside itself — MDN, "SVG as an image": scripts
 * are off, and external images and stylesheets are refused unless inlined as
 * `data:` URLs. A logo linked by URL would never paint, so it has to be carried
 * inside the markup. The same rule is also why this is safe: whatever an
 * operator's SVG contains, inside an image it runs nothing and fetches nothing.
 *
 * ── Same origin, and a redirect is a failure ────────────────────────────────
 *
 * `src` is `/uploads/branding/<file>` (`isQrLogoSrc`) — the cabinet API relays
 * it from the panel through a disk mirror, so it is same-origin and inside the
 * page's `connect-src 'self'`. When neither the mirror nor the panel has the
 * file, the relay answers `302` to the stock Reiwa icon (`src/api/app.ts`, the
 * `/uploads/branding/:file` route) so an entry screen's `<img>` never breaks.
 * In a QR code that icon would be somebody else's brand on the operator's code,
 * so `response.redirected` is no logo at all. (The service worker does not
 * cache `/uploads/`, for the same stock-icon reason — see `sw.ts`.)
 *
 * ── Raster and SVG ──────────────────────────────────────────────────────────
 *
 *   - A raster image (PNG, JPEG, WebP) is drawn through a canvas, at most
 *     `LOGO_RASTER_MAX_EDGE` pixels on its long side, and handed on as a PNG.
 *     The plate is under 60 CSS px at every size the cabinet shows a logo, so
 *     256 still covers a 3× screen, and an operator's 2000-pixel upload does not
 *     travel inside every code that is drawn.
 *   - An SVG is inlined whole, base64, up to `LOGO_SVG_MAX_BYTES` (96 KB).
 *     Anything larger is no logo: an SVG is not drawn through a canvas here, so
 *     a larger file would ride inside the code as it is.
 *
 * ── Quiet failure, one load per image ───────────────────────────────────────
 *
 * Every failure — a bad source, a network error, a 404, a redirect, a type
 * this cannot draw, a file over its limit, a canvas that refuses — answers
 * `null`, and a caller draws the code without a logo, which is what the code
 * would be had none been configured. Nothing here throws.
 *
 * Loads are shared per `src` for the life of the page, in flight and once
 * done. A failed load is forgotten, so the next screen that asks tries again:
 * the relay's stock-icon redirect is exactly the kind of failure that clears
 * up when the panel comes back.
 */
import { useEffect, useMemo, useState } from 'react'

import { planQrLogo } from './qr-logo'
import { type QrStyle, isQrLogoHref, isQrLogoSrc } from './qr-style'

/** The largest SVG inlined as it is. */
export const LOGO_SVG_MAX_BYTES = 96 * 1024
/** The largest raster upload decoded at all — far above any logo, well below what a phone should decode for one. */
export const LOGO_RASTER_MAX_BYTES = 8 * 1024 * 1024
/** A raster logo's long side after it is drawn through the canvas, in pixels. */
export const LOGO_RASTER_MAX_EDGE = 256

/** The part of a `fetch` response the loader reads. */
export interface QrLogoResponse {
  readonly ok: boolean
  readonly redirected: boolean
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface QrLogoLoaderEnvironment {
  readonly fetch: (src: string) => Promise<QrLogoResponse>
  /**
   * A raster image's bytes → a `data:image/png;base64,…` URI no larger than
   * `maxEdge` on either side, or `null`.
   */
  readonly rasterise: (bytes: ArrayBuffer, type: RasterType, maxEdge: number) => Promise<string | null>
}

export type RasterType = 'image/png' | 'image/jpeg' | 'image/webp'
type LogoKind = RasterType | 'image/svg+xml'

const RASTER_TYPES: readonly RasterType[] = ['image/png', 'image/jpeg', 'image/webp']

const TYPE_BY_EXTENSION: Readonly<Record<string, LogoKind>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

const BROWSER: QrLogoLoaderEnvironment = {
  // Read at call time, not captured at import, so the page's `fetch` is the one used.
  fetch: (src) => globalThis.fetch(src, { credentials: 'same-origin' }),
  rasterise: rasteriseThroughCanvas,
}

/** A loader with its own cache. The cabinet uses `loadQrLogo`; tests hand in an environment. */
export function createQrLogoLoader(
  environment: QrLogoLoaderEnvironment = BROWSER,
): (src: string) => Promise<string | null> {
  const loads = new Map<string, Promise<string | null>>()
  return (src: string) => {
    const known = loads.get(src)
    if (known !== undefined) return known
    const load = loadOnce(environment, src).catch(() => null)
    loads.set(src, load)
    void load.then((href) => {
      if (href === null && loads.get(src) === load) loads.delete(src)
    })
    return load
  }
}

/** The cabinet's loader: `/uploads/branding/<file>` → a `data:` URI, or `null`. Never rejects. */
export const loadQrLogo: (src: string) => Promise<string | null> = createQrLogoLoader()

/**
 * The style's logo, loaded — for a code of `text` shown at `displayPixels`.
 *
 * `undefined` until it has loaded, and for good when it cannot: no logo in the
 * style, no plan for this text at this size (so nothing is fetched for a code
 * that could not carry one), or a failed load. Hand the result straight to
 * `qrSvg`, which draws the logo-less code for `undefined` — so a code is on
 * screen the whole time, and never a broken image.
 */
export function useQrLogoHref(text: string, style: QrStyle, displayPixels: number): string | undefined {
  const src = style.logo === null ? null : style.logo.src
  const wanted = useMemo(
    () => src !== null && planQrLogo(text, style, displayPixels) !== null,
    [text, style, displayPixels, src],
  )
  const [loaded, setLoaded] = useState<{ readonly src: string; readonly href: string | null } | null>(null)

  useEffect(() => {
    if (!wanted || src === null) return undefined
    let cancelled = false
    void loadQrLogo(src).then((href) => {
      if (!cancelled) setLoaded({ src, href })
    })
    return () => {
      cancelled = true
    }
  }, [wanted, src])

  return wanted && loaded !== null && loaded.src === src && loaded.href !== null ? loaded.href : undefined
}

async function loadOnce(environment: QrLogoLoaderEnvironment, src: string): Promise<string | null> {
  if (!isQrLogoSrc(src)) return null
  const response = await environment.fetch(src)
  // The relay's stock icon, or any other page than the file asked for.
  if (!response.ok || response.redirected) return null

  const kind = logoKind(response.headers.get('content-type'), src)
  if (kind === null) return null
  const bytes = await response.arrayBuffer()

  if (kind === 'image/svg+xml') {
    if (bytes.byteLength === 0 || bytes.byteLength > LOGO_SVG_MAX_BYTES) return null
    // An error page labelled as an SVG is not a logo.
    if (!/<svg[\s>]/i.test(new TextDecoder().decode(bytes))) return null
    const href = `data:image/svg+xml;base64,${base64(bytes)}`
    return isQrLogoHref(href) ? href : null
  }

  if (bytes.byteLength === 0 || bytes.byteLength > LOGO_RASTER_MAX_BYTES) return null
  const href = await environment.rasterise(bytes, kind, LOGO_RASTER_MAX_EDGE)
  return href !== null && href.startsWith('data:image/png;base64,') && isQrLogoHref(href) ? href : null
}

/**
 * The type to draw the response as. A declared image type wins; with none, or
 * the relay's `application/octet-stream`, the extension `isQrLogoSrc` already
 * required decides — the relay's disk mirror types files by extension alone.
 * Any other declared type (an HTML error page, say) is not a logo.
 */
function logoKind(contentType: string | null, src: string): LogoKind | null {
  const essence = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (essence === 'image/svg+xml') return 'image/svg+xml'
  if ((RASTER_TYPES as readonly string[]).includes(essence)) return essence as RasterType
  if (essence !== '' && essence !== 'application/octet-stream') return null
  const extension = src.slice(src.lastIndexOf('.') + 1).toLowerCase()
  return TYPE_BY_EXTENSION[extension] ?? null
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  // Chunked: `String.fromCharCode(...all)` overflows the argument limit on a large file.
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** The browser's rasteriser: decode, draw no larger than `maxEdge`, export as PNG. */
async function rasteriseThroughCanvas(
  bytes: ArrayBuffer,
  type: RasterType,
  maxEdge: number,
): Promise<string | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const { naturalWidth: width, naturalHeight: height } = image
    if (!(width > 0 && height > 0)) return null
    const scale = Math.min(1, maxEdge / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (context === null) return null
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
