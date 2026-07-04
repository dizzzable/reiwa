import { useQuery } from '@tanstack/react-query'
import { getNotifications } from '@/lib/api-client'
import { useSession } from './use-session'

/**
 * Count of UNREAD support replies (operator answered a ticket, the user hasn't
 * opened it yet). Derived from the same `['notifications']` feed the bell and
 * the settings badge use, so it reflects the real number of unread replies and
 * clears the instant the user opens the ticket (which marks the `support_reply`
 * events read and invalidates this key). Shared so the Support nav item badge
 * and the header bell stay in lockstep.
 */
export function useSupportUnread(): number {
  const { isAuthenticated } = useSession()

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => getNotifications(),
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  return (data?.notifications ?? []).filter(
    (n) => n.type === 'support_reply' && !n.readAt,
  ).length
}
