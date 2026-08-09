import { motion } from 'motion/react'

import { BrandLogo } from './brand-logo'

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
 * The entrance is opacity-only ON PURPOSE. The tile carries `backdrop-blur-xl`,
 * and animating geometry (the old `scale: 0.8 → 1` spring, or any x/y) on a
 * backdrop-filtered element forces WebKit to re-sample and re-blur the whole
 * backdrop on every frame of the spring — measured jank on iOS exactly while
 * the entry screens mount. Keep springs for elements WITHOUT backdrop-filter;
 * never reintroduce scale/x/y here.
 */
export function EntryBrandTile({ size = 'md', className }: EntryBrandTileProps) {
  const isLg = size === 'lg'
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
        className={`flex items-center justify-center bg-[color:var(--color-surface)] ring-1 ring-[color:var(--color-border-soft)] backdrop-blur-xl ${
          isLg ? 'h-24 w-24 rounded-[28px]' : 'h-20 w-20 rounded-3xl'
        }`}
        style={{ boxShadow: '0 0 60px var(--color-brand-glow)' }}
      >
        <BrandLogo className={isLg ? 'h-14 w-14' : 'h-11 w-11'} />
      </div>
    </motion.div>
  )
}
