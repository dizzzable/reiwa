import { useEffect } from 'react'

import { setAppBadge } from '@/lib/app-badge'
import { useNotificationBadge } from './use-notification-badge'
import { useSession } from './use-session'

/**
 * Keeps the home-screen icon's number in step with the inbox while the app is
 * open.
 *
 * ── Why this exists beside the push handler ─────────────────────────────────
 *
 * The service worker sets the badge when a push arrives, which covers the app
 * being CLOSED. It cannot cover the app being open: the subscriber reads three
 * notifications and, without this, the icon keeps claiming three until some
 * later push happens to correct it. Between the two the number is right in
 * both states.
 *
 * ── No new request ──────────────────────────────────────────────────────────
 *
 * The count comes from `useNotificationBadge`, which asks for the same
 * `['notifications', 'unread-count']` the bell asks for — one request, one
 * cache entry, three readers. It also means "mark all read" moves the icon
 * through the same invalidation that moves the bell, with nothing here to keep
 * in step by hand.
 *
 * ── What number goes on the icon ────────────────────────────────────────────
 *
 * The TOTAL unread, support replies included. The bell subtracts those when
 * Support has its own nav tab carrying its own badge, because two badges on
 * one screen counting the same thing is a miscount to whoever reads them. The
 * icon is not on that screen: from the home screen there is one app and one
 * number, and it has to mean "this much is waiting for you".
 */
export function useAppBadge(): void {
  const { isAuthenticated } = useSession()
  const count = useNotificationBadge()

  useEffect(() => {
    // "Not known" is not "zero", and writing zero for it is how this feature
    // erases its own result.
    //
    // On a cold start the session is still loading, so `isAuthenticated` is
    // false and the count query has not run: an effect that treated that as
    // zero cleared, on every single launch, a badge a push had set correctly
    // while the app was closed. Worse, `useSession` swallows its own errors and
    // answers `null`, so a network failure is indistinguishable from a
    // sign-out — and this product sells a VPN, i.e. the app is opened exactly
    // when the connection is broken.
    //
    // So: write only what we actually know. Clearing on sign-out is a separate
    // job with a separate trigger — see `clearAppBadge` at the sign-out sites,
    // which fire before this component is unmounted and cannot be done from
    // here at all.
    if (!isAuthenticated || count === undefined) return
    void setAppBadge(count)
  }, [count, isAuthenticated])
}
