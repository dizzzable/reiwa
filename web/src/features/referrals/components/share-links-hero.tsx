import { useTranslation } from 'react-i18next'

import { Skeleton } from '@/components/ui/skeleton'

import type { ShareLinks } from '../use-share-links'
import { InviteLinkHero } from './invite-link-hero'

/**
 * The invite hero, or what stands in its place while there is no link to show.
 *
 * Under «только по приглашениям» the link waits for the account's invite, and
 * there may be none to have — no slot left, or the panel refused. Then this
 * says so instead of handing out the permanent code, which the platform would
 * refuse at the friend's registration: a link that looks fine and fails later
 * is the defect this replaced.
 */
export function ShareLinksHero({ links, brandName }: { readonly links: ShareLinks; readonly brandName?: string | null }) {
  const { t } = useTranslation()
  if (links.state === 'pending') return <Skeleton data-share-links="pending" className="h-40 w-full rounded-2xl" />
  if (links.state === 'unavailable') {
    return (
      <p data-share-links="unavailable" className="rounded-2xl border border-border/60 px-4 py-3 text-sm text-muted-foreground">
        {t('referrals.inviteLinkUnavailable')}
      </p>
    )
  }
  return <InviteLinkHero telegramLink={links.telegramLink} webLink={links.webLink} brandName={brandName ?? undefined} />
}
