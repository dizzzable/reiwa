import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { PressWatermark } from './press-watermark'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg'

export type { ButtonVariant, ButtonSize }

interface StadiumButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'left' | 'right'
  fullWidth?: boolean
  glow?: boolean
  /**
   * Holographic watermark text drawn inside the button (the operator's brand
   * name on the auth screens). Requires the button to sit inside a
   * `.press-zone` (`<PressPlate>`) for the torch to follow the cursor; without
   * one the faint stencil still shows, the torch stays centred.
   */
  watermark?: string
}

/**
 * Pill ("stadium") CTA. The primary variant is driven by the operator's
 * `--brand-primary` / `--brand-primary-fg` tokens (set by BrandingProvider)
 * rather than a hardcoded palette, so CTAs match the active branding.
 */
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-(--brand-primary) text-(--brand-primary-fg) hover:brightness-110 active:brightness-95 shadow-[0_0_24px_var(--color-brand-glow)] hover:shadow-[0_0_36px_var(--color-brand-glow)]',
  secondary:
    'border border-[var(--color-border-soft)] bg-[var(--color-surface-high)] text-[var(--brand-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface)]',
  ghost: 'bg-transparent text-[var(--brand-muted-foreground)] hover:bg-[var(--color-surface)] hover:text-[var(--brand-foreground)]',
  danger:
    'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 hover:text-red-300',
  outline:
    'bg-transparent text-(--brand-ink-text) border border-(--brand-ink)/50 hover:bg-(--brand-ink)/10 hover:border-(--brand-ink)/80',
}

const sizeClasses: Record<ButtonSize, string> = {
  // `--press-aperture` is the radius of the watermark torch, sized per pill:
  // the same 96 px window that reads as a spotlight on an h-14 CTA would light
  // the WHOLE of an h-9 pill, i.e. turn the flashlight back into a sticker.
  // The pool of light and the letters inside it read the same variable.
  sm: 'h-9  px-4 text-sm  gap-1.5 [--press-aperture:56px]',
  md: 'h-11 px-6 text-sm  gap-2   [--press-aperture:72px]',
  lg: 'h-14 px-8 text-base gap-2.5 [--press-aperture:96px]',
}

/**
 * The pill's own classes, shared with the link form of the same control
 * (`PressLink`) so a navigation pill and a submit pill cannot drift apart.
 */
export function stadiumClasses({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
} = {}): string {
  return cn(
    'inline-flex items-center justify-center rounded-full font-medium',
    // Positioning context for the watermark layer, clipped to the pill.
    'relative isolate overflow-hidden',
    'transition-all duration-200 ease-out',
    'active:scale-[0.97] select-none cursor-pointer',
    'disabled:opacity-40 disabled:pointer-events-none',
    variantClasses[variant],
    sizeClasses[size],
    fullWidth && 'w-full',
  )
}

export const StadiumButton = forwardRef<HTMLButtonElement, StadiumButtonProps>(
  function StadiumButton(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      iconPosition = 'left',
      fullWidth = false,
      glow = false,
      watermark,
      children,
      className,
      disabled,
      ...props
    },
    ref,
  ) {
    const isDisabled = disabled || loading

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={cn(
          stadiumClasses({ variant, size, fullWidth }),
          glow && variant === 'primary' && 'animate-pulse-glow',
          className,
        )}
        {...props}
      >
        {watermark ? <PressWatermark text={watermark} /> : null}
        {loading ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <>
            {icon && iconPosition === 'left' && <span className="shrink-0">{icon}</span>}
            {children && <span>{children}</span>}
            {icon && iconPosition === 'right' && <span className="shrink-0">{icon}</span>}
          </>
        )}
      </button>
    )
  },
)
