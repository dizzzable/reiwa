import { forwardRef, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg'

interface StadiumButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'left' | 'right'
  fullWidth?: boolean
  glow?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:   'bg-rose-500 text-white hover:bg-rose-600 active:bg-rose-700 shadow-[0_0_20px_rgba(244,63,94,0.4)] hover:shadow-[0_0_32px_rgba(244,63,94,0.6)]',
  secondary: 'bg-zinc-800/80 text-white border border-white/10 hover:bg-zinc-700/80 hover:border-white/20',
  ghost:     'bg-transparent text-zinc-300 hover:bg-white/6 hover:text-white',
  danger:    'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 hover:text-red-300',
  outline:   'bg-transparent text-rose-400 border border-rose-500/50 hover:bg-rose-500/10 hover:border-rose-500/80',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-9  px-4 text-sm  gap-1.5',
  md: 'h-11 px-6 text-sm  gap-2',
  lg: 'h-14 px-8 text-base gap-2.5',
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
          'inline-flex items-center justify-center rounded-full font-medium',
          'transition-all duration-200 ease-out',
          'active:scale-[0.97] select-none cursor-pointer',
          'disabled:opacity-40 disabled:pointer-events-none',
          variantClasses[variant],
          sizeClasses[size],
          fullWidth && 'w-full',
          glow && variant === 'primary' && 'animate-pulse-glow',
          className,
        )}
        {...props}
      >
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
