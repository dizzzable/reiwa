/**
 * The QR logo loader, on its own: what counts as a logo, what does not, and
 * how often it asks. Driven through `createQrLogoLoader` with the network and
 * the canvas handed in, so every branch is reached — the call sites reach the
 * SVG one through a stubbed `fetch` in `qr-style-call-sites.test.tsx`.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  LOGO_RASTER_MAX_BYTES,
  LOGO_RASTER_MAX_EDGE,
  LOGO_SVG_MAX_BYTES,
  type QrLogoLoaderEnvironment,
  type QrLogoResponse,
  createQrLogoLoader,
} from '@/lib/qr-logo-source'
import { isQrLogoHref } from '@/lib/qr-style'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>'
const PNG_OUT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='

function response(body: string | Uint8Array, over: Partial<{ ok: boolean; redirected: boolean; type: string | null }> = {}): QrLogoResponse {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  const type = over.type === undefined ? 'image/svg+xml' : over.type
  return {
    ok: over.ok ?? true,
    redirected: over.redirected ?? false,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.slice().buffer,
  }
}

function environment(answer: (src: string) => Promise<QrLogoResponse>, rasterised: string | null = PNG_OUT) {
  const fetch = vi.fn(answer)
  const rasterise = vi.fn<QrLogoLoaderEnvironment['rasterise']>(async () => rasterised)
  return { fetch, rasterise, load: createQrLogoLoader({ fetch, rasterise }) }
}

describe('loading an SVG logo', () => {
  it('inlines it whole, as a base64 data URI the renderer accepts', async () => {
    const { load, rasterise } = environment(async () => response(SVG))
    const href = await load('/uploads/branding/mark.svg')
    expect(href).toBe(`data:image/svg+xml;base64,${btoa(SVG)}`)
    expect(isQrLogoHref(href)).toBe(true)
    expect(rasterise).not.toHaveBeenCalled()
  })

  it(`refuses one over ${LOGO_SVG_MAX_BYTES} bytes, and takes one at exactly the limit`, async () => {
    const padded = (bytes: number): string => {
      const head = '<svg xmlns="http://www.w3.org/2000/svg">'
      return `${head}${' '.repeat(bytes - head.length - '</svg>'.length)}</svg>`
    }
    expect(new TextEncoder().encode(padded(LOGO_SVG_MAX_BYTES)).length).toBe(LOGO_SVG_MAX_BYTES)
    expect(await environment(async () => response(padded(LOGO_SVG_MAX_BYTES))).load('/uploads/branding/a.svg')).not.toBeNull()
    expect(await environment(async () => response(padded(LOGO_SVG_MAX_BYTES + 1))).load('/uploads/branding/b.svg')).toBeNull()
    expect(LOGO_SVG_MAX_BYTES).toBe(96 * 1024)
  })

  it('refuses a page that only says it is an SVG — an error page is not a logo', async () => {
    const { load } = environment(async () => response('<!doctype html><title>502</title>'))
    expect(await load('/uploads/branding/mark.svg')).toBeNull()
  })
})

describe('loading a raster logo', () => {
  it('draws it through the canvas, no larger than the edge, and hands on the PNG', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const { load, rasterise } = environment(async () => response(bytes, { type: 'image/png' }))
    expect(await load('/uploads/branding/mark.png')).toBe(PNG_OUT)
    expect(rasterise).toHaveBeenCalledTimes(1)
    const [given, type, edge] = rasterise.mock.calls[0] ?? []
    expect([...new Uint8Array(given as ArrayBuffer)]).toEqual([...bytes])
    expect([type, edge]).toEqual(['image/png', LOGO_RASTER_MAX_EDGE])
    expect(LOGO_RASTER_MAX_EDGE).toBe(256)
  })

  it('takes the type from the extension when the relay answers octet-stream — its disk mirror knows no better', async () => {
    const { load, rasterise } = environment(async () => response(new Uint8Array([1]), { type: 'application/octet-stream' }))
    expect(await load('/uploads/branding/photo.JPG')).toBe(PNG_OUT)
    expect(rasterise.mock.calls[0]?.[1]).toBe('image/jpeg')
  })

  it('refuses what the canvas refuses, and anything that is not a PNG out of it', async () => {
    expect(await environment(async () => response(new Uint8Array([1]), { type: 'image/webp' }), null).load('/uploads/branding/a.webp')).toBeNull()
    expect(
      await environment(async () => response(new Uint8Array([1]), { type: 'image/png' }), 'data:image/jpeg;base64,AAAA').load(
        '/uploads/branding/b.png',
      ),
    ).toBeNull()
    expect(
      await environment(async () => response(new Uint8Array([1]), { type: 'image/png' }), 'data:,').load('/uploads/branding/c.png'),
    ).toBeNull()
  })

  it(`refuses a file over ${LOGO_RASTER_MAX_BYTES} bytes without decoding it`, async () => {
    const { load, rasterise } = environment(async () =>
      response(new Uint8Array(LOGO_RASTER_MAX_BYTES + 1), { type: 'image/png' }),
    )
    expect(await load('/uploads/branding/huge.png')).toBeNull()
    expect(rasterise).not.toHaveBeenCalled()
  })
})

describe('what is not a logo at all', () => {
  it.each([
    ['a redirect — the relay sending the stock Reiwa icon while the panel is down', { redirected: true, type: 'image/png' }],
    ['a 404', { ok: false }],
    ['a declared type that is not an image', { type: 'text/html' }],
  ] as const)('%s', async (_label, over) => {
    const { load, rasterise } = environment(async () => response(SVG, over))
    expect(await load('/uploads/branding/mark.svg')).toBeNull()
    expect(rasterise).not.toHaveBeenCalled()
  })

  it('a network failure — and nothing throws', async () => {
    const { load } = environment(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(load('/uploads/branding/mark.svg')).resolves.toBeNull()
  })

  it('a source that is not a relayed upload is never even fetched', async () => {
    const { load, fetch } = environment(async () => response(SVG))
    for (const src of ['https://cdn.example.com/mark.svg', '/uploads/icons/mark.svg', '/uploads/branding/../x.svg', '']) {
      expect(await load(src), src).toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('how often it asks', () => {
  it('shares one load per source — in flight and once done', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { load, fetch } = environment(async () => {
      await held
      return response(SVG)
    })
    const first = load('/uploads/branding/mark.svg')
    const second = load('/uploads/branding/mark.svg')
    release()
    expect(await first).toBe(await second)
    expect(await load('/uploads/branding/mark.svg')).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    await load('/uploads/branding/other.svg')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('forgets a failed load, so the next screen that asks tries again', async () => {
    let redirect = true
    const { load, fetch } = environment(async () => response(SVG, redirect ? { redirected: true } : {}))
    expect(await load('/uploads/branding/mark.svg')).toBeNull()
    redirect = false
    // The panel is back.
    expect(await load('/uploads/branding/mark.svg')).not.toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
