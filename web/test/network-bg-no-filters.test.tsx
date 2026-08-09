// @vitest-environment jsdom

/**
 * NetworkBg must stay filter-free.
 *
 * It renders fixed at viewport size behind every entry screen, and WebKit
 * re-rasterises any `filter`ed layer of that size on every viewport change —
 * each iOS address-bar / Telegram-header collapse re-ran three big Gaussian
 * blurs plus a full-viewport SVG `feGaussianBlur`. The blobs are pre-blurred
 * radial gradients instead; this spec pins that property so a future visual
 * tweak cannot quietly reintroduce per-viewport-change rasterisation.
 *
 * THE CLASS SCAN IS NOT DECORATION. This spec used to read only
 * `element.style.filter` / `.backdropFilter` and the SVG `<filter>` nodes, and
 * an audit proved it blind to the one regression that had already happened
 * once: the blobs it guards were ORIGINALLY Tailwind blurs, and adding
 * `blur-3xl` back to a blob's className survived every assertion. jsdom never
 * applies the stylesheet, so a utility class produces no computed `filter`
 * here and no inline style either. The only thing that can see it is the class
 * text — hence FILTER_UTILITIES below, which lists every Tailwind utility that
 * compiles to `filter`/`backdrop-filter`, not just the blur spellings.
 */

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NetworkBg } from '../src/components/ui/network-bg'

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(element: ReactElement): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root?.render(element))
  return container
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

/**
 * Every Tailwind utility family that compiles to `filter` or `backdrop-filter`
 * (v4: filter, backdrop-filter). A class is forbidden when its base is one of
 * these exactly, or starts with one followed by `-` — so `blur`, `blur-3xl`,
 * `blur-[6px]`, `drop-shadow-lg` and `backdrop-blur-xl` are all caught, while
 * `shadow-lg` and `opacity-50` (box-shadow / plain opacity) are not.
 */
const FILTER_BASES = [
  'filter',
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'saturate',
  'sepia',
]
const FILTER_UTILITIES = [
  ...FILTER_BASES,
  ...FILTER_BASES.map((base) => `backdrop-${base}`),
  // `backdrop-opacity-*` is a backdrop-filter too; bare `opacity-*` is not.
  'backdrop-opacity',
]

/** A class token minus its variants (`md:hover:blur-sm` → `blur-sm`) and `!`. */
function utilityBase(token: string): string {
  let depth = 0
  let lastColon = -1
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index]
    if (character === '[' || character === '(') depth += 1
    else if (character === ']' || character === ')') depth -= 1
    else if (character === ':' && depth === 0) lastColon = index
  }
  return token.slice(lastColon + 1).replace(/^[!-]+/, '')
}

/** The filter utilities present in a `class` attribute, if any. */
function filterUtilitiesIn(classAttribute: string): string[] {
  return classAttribute
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      // `[filter:blur(4px)]` / `[backdrop-filter:…]` — the arbitrary-property
      // spelling, which has no utility name to match on.
      if (/\[(?:-\w+-)?(?:backdrop-)?filter:/.test(token)) return true
      const base = utilityBase(token)
      return FILTER_UTILITIES.some(
        (utility) => base === utility || base.startsWith(`${utility}-`),
      )
    })
}

describe('NetworkBg', () => {
  it('renders no CSS filter and no SVG filter anywhere', () => {
    const rendered = mount(<NetworkBg intensity="medium" />)

    const elements = Array.from(rendered.querySelectorAll<Element>('*'))
    expect(elements.length, 'NetworkBg rendered nothing — the scan proves nothing').toBeGreaterThan(5)
    for (const element of elements) {
      const style = (element as HTMLElement).style
      // Inline spellings. `style` exists on SVGElement too, so this covers the
      // whole tree, not only the `<div>`s.
      expect(style?.filter ?? '').toBe('')
      expect(style?.backdropFilter ?? '').toBe('')
      expect(style?.getPropertyValue('-webkit-backdrop-filter') ?? '').toBe('')

      // Utility spellings. `element.className` is an SVGAnimatedString on SVG
      // nodes, so read the attribute rather than the property.
      const classAttribute = element.getAttribute('class') ?? ''
      const offenders = filterUtilitiesIn(classAttribute)
      expect(
        offenders,
        `<${element.tagName.toLowerCase()} class="${classAttribute}"> in NetworkBg carries the Tailwind filter utility \`${offenders[0]}\` — that compiles to filter/backdrop-filter on a layer fixed at viewport size, so WebKit re-rasterises it on every iOS address-bar or Telegram-header collapse`,
      ).toEqual([])
    }
    expect(
      rendered.querySelector('filter'),
      'an SVG <filter> is back in NetworkBg — the full-viewport layer is filtered again',
    ).toBeNull()
    expect(
      rendered.querySelector('feGaussianBlur'),
      'feGaussianBlur is back in NetworkBg — WebKit re-runs it on every viewport change',
    ).toBeNull()
    expect(
      rendered.querySelector('[filter]'),
      'a NetworkBg node references a filter via the `filter` attribute',
    ).toBeNull()
  })

  // The scan above is worth exactly as much as its detector, and the detector
  // is test-only code that nothing else exercises. Pin it: if `utilityBase`
  // stops stripping variants, or the utility list loses a family, this fails
  // here rather than silently passing the real scan on a filtered component.
  it('recognises every spelling of a filter utility', () => {
    for (const token of [
      'blur',
      'blur-3xl',
      'blur-[6px]',
      'backdrop-blur-xl',
      'md:blur-sm',
      'dark:hover:backdrop-blur-md',
      '!blur-lg',
      'drop-shadow-lg',
      'grayscale',
      'backdrop-saturate-150',
      'backdrop-opacity-60',
      '[filter:blur(40px)]',
      '[-webkit-backdrop-filter:blur(4px)]',
      'supports-[backdrop-filter]:backdrop-blur-sm',
    ]) {
      expect(
        filterUtilitiesIn(`absolute inset-0 ${token} rounded-full`),
        `the filter-utility scan no longer sees \`${token}\`, so the NetworkBg guard above is blind to it`,
      ).not.toEqual([])
    }
    for (const token of [
      'shadow-lg',
      'opacity-50',
      'rounded-full',
      'bg-blend-multiply',
      'blurb-thing',
      'text-contrast',
    ]) {
      expect(
        filterUtilitiesIn(`absolute inset-0 ${token}`),
        `the filter-utility scan false-positives on \`${token}\``,
      ).toEqual([])
    }
  })

  it('keeps the pre-blurred brand-driven blobs and the dot grid', () => {
    const rendered = mount(<NetworkBg intensity="medium" />)

    const blobs = Array.from(rendered.querySelectorAll<HTMLElement>('div.rounded-full'))
    expect(blobs).toHaveLength(3)
    for (const blob of blobs) {
      const background = blob.style.background
      expect(background).toContain('--brand-primary')
      // `closest-side`, not the bare `radial-gradient(circle, …)`. The default
      // extent is `farthest-corner` = (S/2)·√2, so on these `rounded-full`
      // boxes the border-radius clips at 70.71% of the stop list and leaves
      // whatever alpha is standing there as a hard ring. Only `closest-side`
      // puts the last stop exactly on the clip radius.
      expect(
        background,
        'a NetworkBg blob dropped `closest-side`, so the rounded-full clip now lands at 70.71% of its stop list and cuts the gradient off at non-zero alpha — a visible ring around the disc',
      ).toContain('radial-gradient(circle closest-side')
      // …and that last stop has to actually be transparent.
      expect(
        background,
        'a NetworkBg blob no longer fades to `transparent 100%`, so its clip edge is a hard step',
      ).toMatch(/transparent\s+100%\)/)
    }
    expect(rendered.querySelector('pattern#net-grid')).not.toBeNull()
    expect(rendered.querySelector('rect')).not.toBeNull()
  })
})
