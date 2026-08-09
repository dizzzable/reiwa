import { memo } from 'react'

interface NetworkBgProps {
  className?: string
  intensity?: 'low' | 'medium' | 'high'
}

/**
 * NetworkBg — ambient branded backdrop behind every screen.
 *
 * Colour is driven by the operator's `--brand-primary` token (set at runtime
 * by BrandingProvider) via `color-mix`, so the glow tracks branding instead of
 * a hardcoded palette. Three soft radial blobs + a faint dot grid and a couple
 * of accent lines give depth without competing with foreground content.
 *
 * NO `filter` ANYWHERE in this component, on purpose. It sits fixed at
 * viewport size behind every entry screen, and WebKit re-rasterises a filtered
 * layer of that size on each viewport change — every iOS address-bar or
 * Telegram-header collapse re-ran three big Gaussians plus a full-screen SVG
 * blur. The blobs are therefore "pre-blurred": multi-stop radial gradients
 * whose alpha reproduces the old `blur(40–60px)` output, rasterised once.
 *
 * THE THREE NUMBERS THAT MAKE THAT TRUE — change one, recompute all three:
 *
 * 1. `closest-side`, never the default. A bare `radial-gradient(circle, …)`
 *    sizes to `farthest-corner` = (S/2)·√2, so on a `rounded-full` box the
 *    border-radius clips at 70.71% of the stop list. The first attempt at this
 *    rewrite ended its stops at 100% and left 3.9%/2.2%/1.7% brand alpha
 *    standing at the clip — a hard ring around each disc (ΔE76 ≈ 1.6 on the
 *    dark default, and ≈ 1.6 on a light concept too, where it flips from a
 *    glow to a dark chroma rim and reads like a smudge). `closest-side` puts
 *    100% exactly on the clip radius, so the disc ends at alpha 0.
 *
 * 2. The boxes are the BLURRED extent, not the original ones. `blur(40px)` is
 *    a Gaussian with σ=40px, so the old discs painted ~3σ past their boxes:
 *    the 384px disc was visible out to r≈262px, not 192px. Keeping the old
 *    384/320/256 boxes with a closest-side gradient turns one soft ambient
 *    wash into three small discs. Each box is therefore grown to twice its
 *    blurred radius AROUND THE ORIGINAL CENTRE (the offsets below are the
 *    old centre minus the new radius), so the glow sits where it always did.
 *
 * 3. The stop alphas are the numerically convolved profile, sampled at
 *    0/15/32/50/68/84/100% of the new radius — NOT the old centre alphas.
 *    Blurring a cone lowers its peak: 18%→13.3%, 10%→5.3%, 7%→3.6%. Piecewise
 *    linear between those seven stops tracks the true blurred profile to
 *    within 0.25pp of alpha, and the residual at 100% is under 0.04%.
 */
export const NetworkBg = memo(function NetworkBg({ className = '', intensity = 'medium' }: NetworkBgProps) {
  const opacity = intensity === 'low' ? 0.3 : intensity === 'high' ? 0.7 : 0.5

  /** Brand glow at a given strength — stops of one soft falloff share a hue. */
  const glow = (pct: number) => `color-mix(in oklab, var(--brand-primary) ${pct}%, transparent)`
  const dot = 'color-mix(in oklab, var(--brand-primary) 55%, transparent)'
  const line = 'color-mix(in oklab, var(--brand-primary) 14%, transparent)'

  return (
    <div className={`pointer-events-none fixed inset-0 overflow-hidden ${className}`} aria-hidden>
      {/* Ambient glow blobs — see the three numbers in the docblock above. */}
      {/* was: -top-32 -left-32 h-96 w-96 + blur(40px); centre (64, 64), blurred
          radius 262 → 272px, so top/left = 64 − 272 = −208px. */}
      <div
        className="absolute top-[-208px] left-[-208px] h-[544px] w-[544px] rounded-full"
        style={{
          background: `radial-gradient(circle closest-side, ${glow(13.3)} 0%, ${glow(12.1)} 15%, ${glow(8.8)} 32%, ${glow(4.7)} 50%, ${glow(1.5)} 68%, ${glow(0.3)} 84%, transparent 100%)`,
          opacity,
        }}
      />
      {/* was: top-1/3 -right-24 h-80 w-80 + blur(60px); centre (right − 64,
          33.3% + 160), blurred radius 263 → 272px. */}
      <div
        className="absolute top-[calc(33.333%_-_112px)] right-[-208px] h-[544px] w-[544px] rounded-full"
        style={{
          background: `radial-gradient(circle closest-side, ${glow(5.3)} 0%, ${glow(4.8)} 15%, ${glow(3.4)} 32%, ${glow(1.7)} 50%, ${glow(0.6)} 68%, ${glow(0.2)} 84%, transparent 100%)`,
          opacity,
        }}
      />
      {/* was: bottom-24 left-1/4 h-64 w-64 + blur(50px); centre (25% + 128,
          bottom + 224), blurred radius 207 → 208px. */}
      <div
        className="absolute bottom-4 left-[calc(25%_-_80px)] h-[416px] w-[416px] rounded-full"
        style={{
          background: `radial-gradient(circle closest-side, ${glow(3.6)} 0%, ${glow(3.3)} 15%, ${glow(2.4)} 32%, ${glow(1.3)} 50%, ${glow(0.5)} 68%, ${glow(0.2)} 84%, transparent 100%)`,
          opacity,
        }}
      />

      {/* SVG triangulated network */}
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ opacity: opacity * 0.4 }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <pattern id="net-grid" x="0" y="0" width="80" height="80" patternUnits="userSpaceOnUse">
            <circle cx="40" cy="40" r="1" fill={dot} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#net-grid)" />

        {/* Diagonal accent lines */}
        <line x1="0%" y1="20%" x2="60%" y2="0%" stroke={line} strokeWidth="0.5" />
        <line x1="40%" y1="100%" x2="100%" y2="30%" stroke={line} strokeWidth="0.5" />
        <line x1="0%" y1="60%" x2="80%" y2="100%" stroke={line} strokeWidth="0.5" />
        <line x1="20%" y1="0%" x2="100%" y2="80%" stroke={line} strokeWidth="0.5" />
      </svg>
    </div>
  )
})
