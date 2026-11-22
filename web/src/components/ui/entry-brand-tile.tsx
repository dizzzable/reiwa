import { motion } from 'motion/react'
import type { CSSProperties } from 'react'

import { useBranding } from '@/lib/branding-provider'
import { resolveBrandLogo } from '@/types/branding'
import { resolveItemRadiusPx } from '@/lib/branding-document'
import { BrandLogo } from './brand-logo'
import { brandMarkPlateVisible, resolveBrandMarkGlow } from './brand-mark-glow'
import { resolveBrandLogoGeometry } from './brand-logo-geometry'

interface EntryBrandTileProps {
  /** `lg` is the splash tile (`/`, `/tma`); `md` the form screens. */
  readonly size?: 'md' | 'lg'
  readonly className?: string
}

/**
 * EntryBrandTile — the brand mark every entry screen opens with.
 *
 * It used to be a glowing glass TILE: a rounded square plate, a 1 px ring on
 * its edge and a box-shadow bloom around THAT edge. With the shipped
 * `fill: 1` the mark covered the plate completely, so what the eye got was a
 * highlighted square with a logo inside it — for every logo, because the light
 * belonged to the box and not to the artwork. See `brand-mark-glow.ts` for the
 * replacement: the light is a `drop-shadow` chain on the mark itself, computed
 * from its alpha, so it traces whatever silhouette the operator uploads.
 *
 * What the operator's `brandLogo` still decides: the tile's size (`size`), how
 * much of it the mark fills (`fill`), the corner rounding (`radius`, whose
 * plate leg only matters for `solid` now) and the strength/shape of the light
 * (`glow`, `frame`). The plate survives for `solid` only — an operator who
 * explicitly wants a filled plate gets one, everyone else gets the mark and its
 * own light, which is what a logo is supposed to look like.
 *
 * The entrance is opacity-only ON PURPOSE. The mark can now carry a
 * `filter: drop-shadow`, and animating geometry (the old `scale: 0.8 → 1`
 * spring, or any x/y) under a filter forces a re-rasterisation of the whole
 * chain on every frame of the spring — measured jank on iOS exactly while the
 * entry screens mount. Keep springs for elements WITHOUT filter; never
 * reintroduce scale/x/y here.
 */
export function EntryBrandTile({ size = 'md', className }: EntryBrandTileProps) {
  const { branding } = useBranding()
  // Resolved here, not in the provider: a payload written by a panel older
  // than this setting carries no `brandLogo` at all, and the tile is its only
  // reader.
  const logo = resolveBrandLogo(branding.brandLogo)
  // The tile's corners followed `--radius` before this setting existed, and
  // still do until the operator sets one. Read from the same resolver the
  // document writes that variable from, so the tile cannot disagree with
  // every other rounded surface in the cabinet.
  const geometry = resolveBrandLogoGeometry({
    variant: size,
    logo,
    itemRadiusPx: resolveItemRadiusPx(branding),
  })
  const plate = brandMarkPlateVisible(logo.frame)
  const glow = resolveBrandMarkGlow(logo)

  const tileStyle: CSSProperties = {
    width: `${geometry.tilePx}px`,
    height: `${geometry.tilePx}px`,
    borderRadius: `${geometry.tileRadiusPx}px`,
    backgroundColor: plate ? 'var(--color-surface)' : 'transparent',
    // The box is kept in every case, including no plate at all, so turning the
    // plate off does not move the heading and form below it.
  }

  const markStyle: CSSProperties = {
    width: `${geometry.markPx}px`,
    height: `${geometry.markPx}px`,
    borderRadius: `${geometry.markRadiusPx}px`,
    // No filter key at all when there is no light: an empty string would still
    // create a containing block and a stacking context for nothing.
    filter: glow,
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // A tween, not the spring this used to carry. `damping: 20,
      // stiffness: 200` is ζ = 20 / (2·√200) = 0.707, which overshoots its
      // target by e^(-π) ≈ 4.3% — invisible on an opacity that the compositor
      // clamps at 1, but it means the declared motion is not the motion that
      // runs. The tween's 0.4s matches that spring's 2% settling time
      // (4 / (ζ·ω_n) = 4 / 10), so the entrance is unchanged and the
      // declaration is now honest about being a plain fade.
      transition={{ type: 'tween', duration: 0.4, ease: 'easeOut' }}
      className={className}
    >
      <div
        data-entry-brand-tile={size}
        data-entry-brand-frame={logo.frame}
        data-entry-brand-plate={plate ? 'on' : 'off'}
        className="flex items-center justify-center"
        style={tileStyle}
      >
        <BrandLogo style={markStyle} />
      </div>
    </motion.div>
  )
}
