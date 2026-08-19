import { motion } from 'motion/react'
import type { CSSProperties } from 'react'

import { useBranding } from '@/lib/branding-provider'
import { resolveBrandLogo } from '@/types/branding'
import { resolveItemRadiusPx } from '@/lib/branding-document'
import { BrandLogo } from './brand-logo'
import { resolveBrandLogoGeometry } from './brand-logo-geometry'

interface EntryBrandTileProps {
  /** `lg` is the splash tile (`/`, `/tma`); `md` the form screens. */
  readonly size?: 'md' | 'lg'
  readonly className?: string
}

/**
 * EntryBrandTile — the glowing glass logo tile every entry screen opens with.
 * One component instead of four copies, so the constraint below cannot be
 * un-fixed on one screen and survive on the rest.
 *
 * Its geometry is the operator's: `branding.brandLogo` decides how big the tile
 * is, how much of it the mark fills, how round it is, whether the plate is
 * painted at all and how far the glow reaches. Every default reproduces the
 * fixed rendering this component used to hard-code, so a deployment that never
 * touches the new controls is pixel-identical apart from the mark itself, which
 * gains 2.4 px on the form screens — see `DEFAULT_BRAND_LOGO`.
 *
 * The entrance is opacity-only ON PURPOSE. The tile can carry `backdrop-blur`,
 * and animating geometry (the old `scale: 0.8 → 1` spring, or any x/y) on a
 * backdrop-filtered element forces WebKit to re-sample and re-blur the whole
 * backdrop on every frame of the spring — measured jank on iOS exactly while
 * the entry screens mount. Keep springs for elements WITHOUT backdrop-filter;
 * never reintroduce scale/x/y here. The `solid` frame exists partly for this:
 * it is the same plate without the per-frame backdrop cost.
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
  const filled = logo.frame === 'glass' || logo.frame === 'solid'

  const tileStyle: CSSProperties = {
    width: `${geometry.tilePx}px`,
    height: `${geometry.tilePx}px`,
    borderRadius: `${geometry.tileRadiusPx}px`,
    backgroundColor: filled ? 'var(--color-surface)' : 'transparent',
    // The box is kept in every case, including `none`, so turning the plate off
    // does not move the heading and form below it.
    boxShadow: [
      logo.frame === 'none' ? null : 'inset 0 0 0 1px var(--color-border-soft)',
      logo.glow > 0 ? `0 0 ${Math.round(60 * logo.glow)}px var(--color-brand-glow)` : null,
    ]
      .filter((layer): layer is string => layer !== null)
      .join(', '),
    backdropFilter: logo.frame === 'glass' ? 'blur(24px)' : undefined,
    WebkitBackdropFilter: logo.frame === 'glass' ? 'blur(24px)' : undefined,
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
        className="flex items-center justify-center"
        style={tileStyle}
      >
        <BrandLogo
          style={{
            width: `${geometry.markPx}px`,
            height: `${geometry.markPx}px`,
            borderRadius: `${geometry.markRadiusPx}px`,
          }}
        />
      </div>
    </motion.div>
  )
}
