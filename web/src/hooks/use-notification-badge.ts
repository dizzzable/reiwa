import { useQuery } from '@tanstack/react-query'
import { getUnreadCount } from '@/lib/api-client'
import { useSession } from './use-session'

export function useNotificationBadge(): number {
  const { isAuthenticated } = useSession()

  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => getUnreadCount(),
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  return data?.count ?? 0
}
