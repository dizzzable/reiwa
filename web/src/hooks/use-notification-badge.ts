import { useQuery } from '@tanstack/react-query'
import { getUnreadCount } from '@/lib/api-client'
import { useSession } from './use-session'

/**
 * The unread total, or `undefined` while it is not known.
 *
 * `undefined` is a distinct answer, not a zero. The session query swallows its
 * own errors and answers `null`, so "signed out" and "the network is down" are
 * the same shape here — and this product sells a VPN, i.e. the app gets opened
 * precisely when the connection is broken. A caller that renders a number can
 * fall back to 0; a caller that WRITES somewhere durable, like the home-screen
 * icon, must not, or a failed request wipes a badge a push had set correctly.
 */
export function useNotificationBadge(): number | undefined {
  const { isAuthenticated } = useSession()

  const { data } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: ({ signal }) => getUnreadCount({ signal }),
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  return data?.count
}
