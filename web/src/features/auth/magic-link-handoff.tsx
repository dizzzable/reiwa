import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'

import { magicLinkHandoffTarget } from '@/lib/magic-link'

/**
 * Hands a bot sign-in link on any path to the home page, which is the one place
 * that spends it — before a single route has had the chance to redirect it
 * away. See `lib/magic-link.ts` for the defect this closes.
 *
 * It stands IN PLACE of the routes rather than beside them. Rendered beside
 * them, the protected shell would draw its own `<Navigate to="/bootstrap">` in
 * the same commit, and which of the two redirects wins would be a question of
 * effect order.
 */
export function MagicLinkHandoff({ children }: { readonly children: ReactNode }) {
  const { pathname, search } = useLocation()
  const target = magicLinkHandoffTarget(pathname, search)
  if (target !== null) return <Navigate to={target} replace />
  return <>{children}</>
}
