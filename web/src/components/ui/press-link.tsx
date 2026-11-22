import { forwardRef, type ReactNode } from 'react'
import { Link } from 'react-router'

import { cn } from '@/lib/utils'
import { PressWatermark } from './press-watermark'
import { stadiumClasses, type ButtonSize, type ButtonVariant } from './stadium-button'

interface PressLinkProps {
  /** Router destination. A real `<a href>` — middle-click and "open in new tab" work. */
  to: string
  variant?: ButtonVariant
  size?: ButtonSize
  /** Holographic watermark text; the torch follows the cursor of the enclosing `<PressPlate>`. */
  watermark?: string
  className?: string
  children: ReactNode
}

/**
 * The pill from `StadiumButton`, as a router link.
 *
 * The secondary actions on the entry screens ("Забыли пароль", "Создать
 * аккаунт") must press and light up exactly like the primary CTA but navigate,
 * so they borrow the same class recipe instead of a copy of it. Wrap one in
 * `<PressPlate>` to get the dent under the cursor.
 */
export const PressLink = forwardRef<HTMLAnchorElement, PressLinkProps>(function PressLink(
  { to, variant = 'primary', size = 'md', watermark, className, children },
  ref,
) {
  return (
    <Link
      ref={ref}
      to={to}
      className={cn(stadiumClasses({ variant, size, fullWidth: true }), className)}
    >
      {watermark ? <PressWatermark text={watermark} /> : null}
      <span>{children}</span>
    </Link>
  )
})
