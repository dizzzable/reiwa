import { useQuery } from '@tanstack/react-query'
import { getSession } from '@/lib/api-client'
import type { ReiwaSession } from '@/types/api'

export const SESSION_QUERY_KEY = ['session']

export function useSession() {
  const { data: session, isLoading, error } = useQuery<ReiwaSession | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      try {
        return await getSession()
      } catch {
        return null
      }
    },
    staleTime: 60_000,
    retry: false,
  })

  return {
    session: session ?? null,
    isLoading,
    isAuthenticated: !!session,
    error,
  }
}
