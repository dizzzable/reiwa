import { useQuery } from '@tanstack/react-query'
import { getSession } from '@/lib/api-client'
import type { ReiwaSession } from '@/types/api'

export const SESSION_QUERY_KEY = ['session']
export const SESSION_STALE_TIME_MS = 60_000

/**
 * The one session fetcher. Entry pages that need the session imperatively must
 * go through `queryClient.fetchQuery` with THIS key/fetcher pair rather than
 * calling `getSession()` directly — `useSession()` (mounted app-wide via
 * ad-attribution) issues the same request on the same mount, and only a shared
 * React-Query key lets the two collapse into one `/api/v1/session` round-trip.
 */
export async function fetchSessionOrNull(): Promise<ReiwaSession | null> {
  try {
    return await getSession()
  } catch {
    return null
  }
}

export function useSession() {
  const { data: session, isLoading, error } = useQuery<ReiwaSession | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSessionOrNull,
    staleTime: SESSION_STALE_TIME_MS,
    retry: false,
  })

  return {
    session: session ?? null,
    isLoading,
    isAuthenticated: !!session,
    error,
  }
}
