import type { ReactNode } from 'react'

import { usePressTilt } from '@/hooks/use-press-tilt'
import { cn } from '@/lib/utils'

/**
 * Wraps a control so it dents under the cursor on hover, like the cards on the
 * marketing site (see `usePressTilt` for the mechanics and the two rules).
 *
 * The wrapper is the STATIC pointer zone; the inner `.press-plate` carries the
 * transform (styles live in `index.css`, next to `.glass-icon-btn`).
 */
export function PressPlate({ className, children }: { className?: string; children: ReactNode }) {
  const zoneRef = usePressTilt<HTMLDivElement>()

  return (
    <div ref={zoneRef} className={cn('press-zone', className)}>
      <div className="press-plate h-full w-full">{children}</div>
    </div>
  )
}
