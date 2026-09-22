import { useQuery } from '@tanstack/react-query'

import { useSession } from '@/hooks/use-session'
import { createReferralInvite, getReferralSummary } from '@/lib/api-client'
import { useBranding } from '@/lib/branding-provider'

/**
 * The two links an account hands to a friend — into the bot, and into this
 * cabinet — carrying a code the platform will actually admit.
 *
 * ── Which code ──────────────────────────────────────────────────────────────
 *
 * Normally the permanent one: the account's reiwa_id, which the panel resolves
 * (as it does a Telegram id or a username) behind `ref_` and `?ref=`.
 *
 * Under «только по приглашениям» (`admissionRequiresInvite`) a sign-up is
 * admitted ONLY through a single-use invite token, so the permanent code hands
 * the friend a link that is refused at registration. The bot has minted a token
 * in that mode for as long as the mode existed; «Рефералы» and «Партнёрка»
 * here did not — so in exactly that mode every link copied from the cabinet
 * failed. The token comes from the call the bot makes, and the panel REUSES a
 * live invite: asking on every visit burns no slot and does not rotate the link.
 *
 * ── The two links ───────────────────────────────────────────────────────────
 *
 * `ref_` is required for the bot to attribute the referrer — a bare `?start=`
 * is read as the plain menu entry (`parseDeeplink`). Without a bot username the
 * Telegram link IS the web link.
 */

export type ShareLinks =
  | { readonly state: 'pending' }
  /** Under «только по приглашениям» with no invite to be had — no slot left, or the panel refused. */
  | { readonly state: 'unavailable' }
  | { readonly state: 'ready'; readonly telegramLink: string; readonly webLink: string }

/** An invite's token from either shape the panel answers with. */
function inviteToken(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const direct = (answer as { token?: unknown }).token
  const nested = (answer as { invite?: { token?: unknown } | null }).invite?.token
  const token = typeof nested === 'string' ? nested : direct
  return typeof token === 'string' && token.length > 0 ? token : null
}

export function useShareLinks(): ShareLinks {
  const { session } = useSession()
  const { botUsername } = useBranding()

  // The same key «Рефералы» already reads the summary under: one request.
  const summary = useQuery({
    queryKey: ['referrals', 'summary'],
    queryFn: getReferralSummary,
    staleTime: 30_000,
  })
  const needsInvite = summary.data?.admissionRequiresInvite === true
  const invite = useQuery({
    queryKey: ['referrals', 'share-invite'],
    queryFn: createReferralInvite,
    enabled: needsInvite,
    // Never from cache. A friend may have spent this invite since it was
    // fetched, and a spent token is the refused link all over again. The panel
    // hands back the live invite while there is one, so asking on every visit
    // costs no slot.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  // Not before the summary has said which mode this is: answering from the
  // session meanwhile showed the permanent code under «только по
  // приглашениям» until it arrived — on «Партнёрка», which does not wait for
  // the summary itself, long enough to copy. A summary that FAILS still falls
  // through to the permanent code below: without it this link has never
  // needed the panel, and the ordinary mode is the one nearly everyone runs.
  if (summary.isPending) return { state: 'pending' }

  let code: string
  if (needsInvite) {
    if (invite.isPending) return { state: 'pending' }
    const token = inviteToken(invite.data)
    if (token === null) return { state: 'unavailable' }
    code = token
  } else {
    code = String(summary.data?.referralCode ?? session?.id ?? session?.telegramId ?? session?.username ?? '')
  }

  const webLink = `${window.location.origin}/register?ref=${encodeURIComponent(code)}`
  const telegramLink = botUsername ? `https://t.me/${botUsername}?start=ref_${code}` : webLink
  return { state: 'ready', telegramLink, webLink }
}
