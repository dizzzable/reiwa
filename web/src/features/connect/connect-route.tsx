/**
 * `/subscription/connect` — which of the two connect screens opens.
 *
 * One route for both, on purpose: every door into connecting — the card's
 * «Подключить», the banner «Не получилось подключиться?», the pop-up button,
 * the deep link — already leads here (`dashboard/connect-door.ts`), and a
 * second route would be a fifth copy of that decision waiting to drift.
 *
 * The walk opens only when the panel says `interactive` AND the catalog is
 * readable: the walk is made of the catalog's devices and apps, and without
 * them the page with every instruction is the screen that still works — it
 * hands the link over with no catalog at all. `?view=page` asks for the page
 * outright: the walk's own «Открыть все инструкции на одном экране».
 *
 * While the catalog is still out the screen shows nothing rather than one
 * mode and then the other. The home screen fetches the same key before any
 * door can be tapped, so this is a cold-start case only.
 */
import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'

import { getConnectPage } from '@/lib/api-client'
import { CONNECT_PAGE_QUERY_KEY } from '@/features/dashboard/connect-door'

import { readCatalog, readConnectScreenMode } from './connect-catalog'
import ConnectPage from './connect-page'

const ConnectWizard = lazy(() => import('./wizard/connect-wizard'))

/** The screen a catalog payload asks for; `page` for anything the walk could not be built from. */
export function connectScreenFor(payload: unknown, view: string | null): 'page' | 'wizard' {
  if (view === 'page') return 'page'
  return readConnectScreenMode(payload) === 'interactive' && readCatalog(payload) !== null ? 'wizard' : 'page'
}

export default function ConnectRoute() {
  const [searchParams] = useSearchParams()
  const catalog = useQuery({
    queryKey: CONNECT_PAGE_QUERY_KEY,
    queryFn: getConnectPage,
    staleTime: 60_000,
  })
  if (catalog.isPending) return null
  if (connectScreenFor(catalog.data, searchParams.get('view')) === 'page') return <ConnectPage />
  return (
    <Suspense fallback={null}>
      <ConnectWizard />
    </Suspense>
  )
}
