import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleDot, Loader2, PartyPopper, Trophy, Users } from 'lucide-react'

import { enterContest, getContests, getWheel, type ContestView } from '@/lib/api-client'
import { BackButton } from '@/components/ui/back-button'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'

/**
 * Events: what is running, and how the person did.
 *
 * Two kinds live here. The wheel is the permanent one and gets a card that
 * simply leads to it. Contests are the temporary kind: a window, a list of
 * prizes, a button — and, once the draw has run, this person's own result
 * and nobody else's. Who else entered, who else won and what anybody's odds
 * were are not on this screen, by design.
 */
export default function EventsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const contests = useQuery({ queryKey: ['contests'], queryFn: getContests })
  const wheel = useQuery({ queryKey: ['wheel'], queryFn: getWheel, staleTime: 60_000 })

  const enter = useMutation({
    mutationFn: (contestId: string) => enterContest(contestId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['contests'] })
      if (result.entered) {
        toast.success(t('events.entered'))
      } else {
        toast.error(
          t(`events.refusal.${result.reason ?? 'NOT_OPEN'}`, t('events.refusal.NOT_OPEN')),
        )
      }
    },
    onError: () => toast.error(t('events.enterFailed')),
  })

  const items = contests.data ?? []
  const running = items.filter((contest) => contest.status === 'ACTIVE')
  const finished = items.filter((contest) => contest.status === 'DRAWN')

  return (
    <div className="mx-auto max-w-md space-y-5 p-4">
      <BackButton fallback="/" />
      <header>
        <h1 className="text-2xl font-bold">{t('events.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('events.subtitle')}</p>
      </header>

      {wheel.data?.enabled ? (
        <Link to="/wheel" className="block rounded-2xl border p-4 transition-colors hover:bg-accent">
          <div className="flex items-center gap-3">
            <CircleDot className="h-6 w-6 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">{t('events.wheel.title')}</div>
              <div className="text-sm text-muted-foreground">
                {wheel.data.canSpin ? t('events.wheel.canSpin') : t('events.wheel.later')}
              </div>
            </div>
          </div>
        </Link>
      ) : null}

      {contests.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 && !wheel.data?.enabled ? (
        <TipCard>{t('events.empty')}</TipCard>
      ) : null}

      {running.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('events.running')}</h2>
          {running.map((contest) => (
            <ContestCard
              key={contest.id}
              contest={contest}
              entering={enter.isPending}
              onEnter={() => enter.mutate(contest.id)}
            />
          ))}
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('events.finished')}</h2>
          {finished.map((contest) => (
            <ContestCard key={contest.id} contest={contest} entering={false} onEnter={() => undefined} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ContestCard({
  contest,
  entering,
  onEnter,
}: {
  readonly contest: ContestView
  readonly entering: boolean
  readonly onEnter: () => void
}) {
  const { t } = useTranslation()
  const title = contest.title?.ru || contest.title?.en || t('events.unnamed')
  const description = contest.description?.ru || contest.description?.en || ''

  return (
    <article className="space-y-3 rounded-2xl border p-4">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{t('events.until', { time: new Date(contest.endAt).toLocaleString() })}</span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          {t('events.entries', { count: contest.entries })}
        </span>
      </div>

      <ul className="space-y-1 text-sm">
        {contest.prizes.map((prize) => (
          <li key={prize.place} className="flex items-center gap-2">
            <Trophy className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="text-muted-foreground">{t('events.place', { place: prize.place })}</span>
            <span>{prize.title?.ru || prize.title?.en || t('events.unnamed')}</span>
          </li>
        ))}
      </ul>

      {contest.status === 'DRAWN' ? (
        <Result contest={contest} />
      ) : contest.entered ? (
        <p className="text-sm font-medium">{t('events.youAreIn')}</p>
      ) : contest.closed !== null ? (
        <p className="text-sm text-muted-foreground">
          {t(`events.refusal.${contest.closed}`, t('events.refusal.NOT_OPEN'))}
        </p>
      ) : (
        <StadiumButton className="w-full" disabled={entering} onClick={onEnter}>
          {t('events.enter')}
        </StadiumButton>
      )}
    </article>
  )
}

/**
 * How this person did. Three cases, worded as three: not this time; won and
 * here it is; won and OWED — an operator will be in touch. The last must not
 * read like the second.
 */
function Result({ contest }: { readonly contest: ContestView }) {
  const { t } = useTranslation()
  const result = contest.myResult
  if (result === null) {
    return <p className="text-sm text-muted-foreground">{t('events.result.notThisTime')}</p>
  }
  const secret = result.prize?.key ?? result.prize?.promoCode ?? null
  return (
    <div className="space-y-1 rounded-lg bg-muted p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <PartyPopper className="h-4 w-4 text-amber-400" />
        {t('events.result.won', {
          place: result.place,
          prize: result.prizeTitle?.ru || result.prizeTitle?.en || t('events.unnamed'),
        })}
      </p>
      {secret ? <p className="break-all font-mono">{secret}</p> : null}
      {result.status === 'PENDING' ? (
        <p className="text-xs text-amber-500">
          {t('events.result.pending')}
          {result.ticketId ? (
            <>
              {' '}
              <Link className="underline underline-offset-2" to={`/support?ticket=${encodeURIComponent(result.ticketId)}`}>
                {t('events.result.openChat')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {result.status === 'REFUSED' ? (
        <p className="text-xs text-muted-foreground">{t('events.result.refused')}</p>
      ) : null}
    </div>
  )
}
