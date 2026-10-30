import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BarChart3, CircleDot, ExternalLink, Loader2, PartyPopper, Ticket, Trophy, Users } from 'lucide-react'

import {
  enterContest,
  getContests,
  getWheel,
  type ContestLeaderboardView,
  type ContestMetric,
  type ContestView,
} from '@/lib/api-client'
import { BackButton } from '@/components/ui/back-button'
import { StadiumButton } from '@/components/ui/stadium-button'
import { TipCard } from '@/components/ui/tip-card'
import { pickLocalized } from '@/lib/pick-localized'
import { formatDateTime, getActiveLocale, openExternalUrl } from '@/lib/utils'

/**
 * Events: what is running, how the person did, and who won.
 *
 * Two kinds live here. The wheel is the permanent one and gets a card that
 * simply leads to it. Contests are the temporary kind: a window, a list of
 * prizes, a button — the conditions, when there are any (a channel to join,
 * tickets for paying and for friends who pay) — and, once the draw has run,
 * this person's own result and the winners with their names masked (the
 * owner, 29.10.2026: everybody should see that a draw went to real people).
 * Who else entered and anybody's odds are not on this screen.
 *
 * A leaderboard (30.10.2026) has no button: everybody in its audience is on
 * it. The card shows the top with names masked, where this person stands,
 * and how much more takes a prize place.
 */
export default function EventsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // Where to join, for a contest whose entry Telegram has just refused.
  const [joinUrls, setJoinUrls] = useState<Readonly<Record<string, string>>>({})

  const contests = useQuery({ queryKey: ['contests'], queryFn: getContests })
  const wheel = useQuery({ queryKey: ['wheel'], queryFn: getWheel, staleTime: 60_000 })

  const enter = useMutation({
    mutationFn: (contestId: string) => enterContest(contestId),
    onSuccess: (result, contestId) => {
      queryClient.invalidateQueries({ queryKey: ['contests'] })
      if (result.entered) {
        toast.success(t('events.entered'))
        return
      }
      if (result.reason === 'CHANNEL_REQUIRED' && typeof result.joinUrl === 'string') {
        const joinUrl = result.joinUrl
        setJoinUrls((current) => ({ ...current, [contestId]: joinUrl }))
      }
      toast.error(t(`events.refusal.${result.reason ?? 'NOT_OPEN'}`, t('events.refusal.NOT_OPEN')))
    },
    onError: () => toast.error(t('events.enterFailed')),
  })

  const items = contests.data ?? []
  const running = items.filter((contest) => contest.status === 'ACTIVE')
  const finished = items.filter((contest) => contest.status === 'DRAWN' || contest.status === 'CANCELLED')

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
              // Only the card whose button was pressed waits; the others stay usable.
              entering={enter.isPending && enter.variables === contest.id}
              joinUrl={joinUrls[contest.id] ?? null}
              onEnter={() => enter.mutate(contest.id)}
            />
          ))}
        </section>
      ) : null}

      {finished.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('events.finished')}</h2>
          {finished.map((contest) => (
            <ContestCard key={contest.id} contest={contest} entering={false} joinUrl={null} onEnter={() => undefined} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

/** «через 3 дня», «in 2 hours» — the nearest whole unit, in the reader's language. */
function relativeFrom(target: Date, now: number): string {
  const seconds = Math.round((target.getTime() - now) / 1000)
  const units: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  const format = new Intl.RelativeTimeFormat(getActiveLocale(), { numeric: 'auto' })
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(Math.max(1, Math.ceil(seconds / 60)), 'minute')
}

function ContestCard({
  contest,
  entering,
  joinUrl,
  onEnter,
}: {
  readonly contest: ContestView
  readonly entering: boolean
  /** Set when Telegram refused the entry for want of the channel. */
  readonly joinUrl: string | null
  readonly onEnter: () => void
}) {
  const { t, i18n } = useTranslation()
  const title = pickLocalized(contest.title, i18n.language, t('events.unnamed'))
  const description = pickLocalized(contest.description, i18n.language, '')
  // The render is pure against the moment the list arrived, not the clock.
  const [now] = useState(() => Date.now())
  const starts = new Date(contest.startAt)
  const ends = new Date(contest.endAt)
  const live = contest.status === 'ACTIVE'
  const channelUrl = contest.channel?.joinUrl ?? joinUrl
  const board = contest.kind === 'LEADERBOARD' ? (contest.leaderboard ?? null) : null

  return (
    <article className="space-y-3 rounded-2xl border p-4" data-testid="contest-card">
      <div>
        <h3 className="font-semibold">{title}</h3>
        {description ? (
          <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {live && starts.getTime() > now ? (
          <span>{t('events.startsAt', { time: formatDateTime(starts) })}</span>
        ) : null}
        {live ? (
          <span>
            {t('events.until', { time: formatDateTime(ends) })}
            {ends.getTime() > now
              ? ` · ${t(board === null ? 'events.drawIn' : 'events.board.resultsIn', { when: relativeFrom(ends, now) })}`
              : ''}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          {board === null
            ? t('events.entries', { count: contest.drawnEntries ?? contest.entries })
            : t('events.board.ranked', { count: board.total })}
        </span>
      </div>

      <ul className="space-y-1 text-sm">
        {contest.prizes.map((prize) => (
          <li key={prize.place} className="flex items-center gap-2">
            <Trophy className="h-4 w-4 shrink-0 text-amber-400" />
            <span className="text-muted-foreground">
              {prize.placeTo != null && prize.placeTo > prize.place
                ? t('events.placeRange', { from: prize.place, to: prize.placeTo })
                : t('events.place', { place: prize.place })}
            </span>
            <span>{pickLocalized(prize.title, i18n.language, t('events.unnamed'))}</span>
          </li>
        ))}
      </ul>

      {board !== null ? <Leaderboard board={board} live={live} /> : null}

      {live && board === null ? <Conditions contest={contest} channelUrl={channelUrl} /> : null}

      {contest.status === 'CANCELLED' ? (
        <p className="text-sm text-muted-foreground">{t('events.cancelled')}</p>
      ) : contest.status === 'DRAWN' ? (
        <>
          {contest.entered || contest.myResult !== null ? <Result contest={contest} /> : null}
          {board === null ? <Winners contest={contest} /> : null}
        </>
      ) : board !== null ? (
        contest.closed === 'NOT_ELIGIBLE' ? (
          <p className="text-sm text-muted-foreground">{t('events.refusal.NOT_ELIGIBLE')}</p>
        ) : null
      ) : contest.entered ? (
        <p className="text-sm font-medium">{t('events.youAreIn')}</p>
      ) : contest.closed !== null ? (
        <p className="text-sm text-muted-foreground">
          {t(`events.refusal.${contest.closed}`, t('events.refusal.NOT_OPEN'))}
        </p>
      ) : (
        <StadiumButton className="w-full" disabled={entering} onClick={onEnter}>
          {entering ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : t('events.enter')}
        </StadiumButton>
      )}

      <Fairness contest={contest} />
    </article>
  )
}

/** What the contest asks beyond the button: its channel, and what earns tickets. */
function Conditions({ contest, channelUrl }: { readonly contest: ContestView; readonly channelUrl: string | null }) {
  const { t } = useTranslation()
  const tickets = contest.tickets ?? null
  if (channelUrl === null && tickets === null) return null
  return (
    <div className="space-y-2 rounded-lg bg-muted p-3 text-sm">
      {channelUrl !== null && !contest.entered ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{t('events.channel.needed')}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            // A t.me link goes to Telegram itself inside the Mini App, and to
            // a new tab in a browser — `openExternalUrl` picks.
            onClick={() => openExternalUrl(channelUrl)}
          >
            {t('events.channel.open')}
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      {tickets !== null ? (
        <div className="space-y-1">
          <p className="flex items-center gap-2 font-medium" data-testid="contest-tickets">
            <Ticket className="h-4 w-4 shrink-0 text-amber-400" />
            {t('events.tickets.mine', { count: tickets.mine })}
          </p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {tickets.perPurchase > 0 ? <li>{t('events.tickets.perPurchase', { count: tickets.perPurchase })}</li> : null}
            {tickets.perReferral > 0 ? <li>{t('events.tickets.perReferral', { count: tickets.perReferral })}</li> : null}
            {tickets.max !== null ? <li>{t('events.tickets.max', { count: tickets.max })}</li> : null}
          </ul>
          <p className="text-xs text-muted-foreground">{t('events.tickets.hint')}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * How this person did. Three cases, worded as three: not this time; won and
 * here it is; won and OWED — an operator will be in touch. The last must not
 * read like the second.
 */
function Result({ contest }: { readonly contest: ContestView }) {
  const { t, i18n } = useTranslation()
  const result = contest.myResult
  if (result === null) {
    // A leaderboard says this person's place on the board itself; «не
    // повезло» is a draw's word, not a ranking's.
    if (contest.kind === 'LEADERBOARD') return null
    return <p className="text-sm text-muted-foreground">{t('events.result.notThisTime')}</p>
  }
  const secret = result.prize?.key ?? result.prize?.promoCode ?? null
  return (
    <div className="space-y-1 rounded-lg bg-muted p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <PartyPopper className="h-4 w-4 text-amber-400" />
        {t('events.result.won', {
          place: result.place,
          prize: pickLocalized(result.prizeTitle, i18n.language, t('events.unnamed')),
        })}
      </p>
      {secret ? <p className="break-all font-mono">{secret}</p> : null}
      {result.status === 'PENDING' && result.held === true && result.ticketId === null ? (
        <p className="text-xs text-amber-500">{t('events.result.held')}</p>
      ) : result.status === 'PENDING' ? (
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

/** A leaderboard score as a person says it: «3 друга», «1 250 ₽», «12,4 ГБ», «350 баллов». */
function useScore(): (metric: ContestMetric | null, score: number, currency: string) => string {
  const { t } = useTranslation()
  return (metric, score, currency) => {
    const locale = getActiveLocale()
    switch (metric) {
      case 'REFERRALS_PAID':
        return t('events.board.friends', { count: score })
      case 'POINTS_EARNED':
        return t('events.board.points', { count: score })
      case 'TRAFFIC': {
        const gb = score / 1024 ** 3
        return t('events.board.gb', { value: gb.toLocaleString(locale, { maximumFractionDigits: gb >= 100 ? 0 : 1 }) })
      }
      case 'PAYMENTS_SUM': {
        const major = score / 100
        try {
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency,
            maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
          }).format(major)
        } catch {
          return `${major.toLocaleString(locale)} ${currency}`
        }
      }
      default:
        return score.toLocaleString(locale)
    }
  }
}

/**
 * The board: what it ranks by, the top with names masked — this person's
 * own row marked — their place when it is below the top, and while it runs
 * how much more takes a prize place.
 */
function Leaderboard({ board, live }: { readonly board: ContestLeaderboardView; readonly live: boolean }) {
  const { t } = useTranslation()
  const score = useScore()
  const say = (value: number) => score(board.metric, value, board.currency)
  const mineInTop = board.top.some((row) => row.me)
  return (
    <div className="space-y-2 rounded-lg bg-muted p-3 text-sm" data-testid="contest-leaderboard">
      {board.metric !== null ? (
        <p className="flex items-center gap-2 font-medium">
          <BarChart3 className="h-4 w-4 shrink-0 text-amber-400" />
          {t(`events.board.metric.${board.metric}`)}
        </p>
      ) : null}
      {live ? <p className="text-xs text-muted-foreground">{t('events.board.everyone')}</p> : null}
      {board.top.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('events.board.empty')}</p>
      ) : (
        <ol className="space-y-0.5">
          {board.top.map((row) => (
            <li
              key={row.rank}
              className={`flex items-center justify-between gap-2 rounded px-1 ${row.me ? 'bg-background font-medium' : ''}`}
            >
              <span className="min-w-0 truncate">
                <span className="mr-2 tabular-nums text-muted-foreground">{row.rank}.</span>
                {row.me ? t('events.board.you') : (row.name ?? t('events.winnerAnon'))}
              </span>
              <span className="shrink-0 tabular-nums">{say(row.score)}</span>
            </li>
          ))}
        </ol>
      )}
      {board.mine !== null && !mineInTop ? (
        <p className="font-medium" data-testid="contest-my-place">
          {t('events.board.mine', { rank: board.mine.rank, score: say(board.mine.score) })}
        </p>
      ) : null}
      {live && board.mine === null ? <p className="text-xs text-muted-foreground">{t('events.board.notYet')}</p> : null}
      {live && board.toPrize !== null ? (
        <p className="text-xs" data-testid="contest-to-prize">
          {board.toPrize === 0 ? t('events.board.holding') : t('events.board.toPrize', { amount: say(board.toPrize) })}
        </p>
      ) : null}
      {board.minScore !== null && board.minScore > 0 ? (
        <p className="text-xs text-muted-foreground">{t('events.board.minScore', { amount: say(board.minScore) })}</p>
      ) : null}
    </div>
  )
}

/** Everybody's view of a finished contest: who took which place, names masked. */
function Winners({ contest }: { readonly contest: ContestView }) {
  const { t, i18n } = useTranslation()
  const winners = contest.winners ?? null
  if (winners === null || winners.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{t('events.winnersTitle')}</p>
      <ul className="space-y-0.5 text-sm" data-testid="contest-winners">
        {winners.map((winner) => (
          <li key={winner.place} className="flex gap-2">
            <span className="text-muted-foreground">{t('events.place', { place: winner.place })}</span>
            <span className="font-medium">{winner.name ?? t('events.winnerAnon')}</span>
            <span className="text-muted-foreground">— {pickLocalized(winner.prizeTitle, i18n.language, t('events.unnamed'))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The draw key: its fingerprint while the contest runs, the key itself once
 * drawn. Folded away — most people never open it, and the ones who do want
 * the whole string to copy.
 */
function Fairness({ contest }: { readonly contest: ContestView }) {
  const { t } = useTranslation()
  const hash = contest.seedHash ?? null
  if (hash === null || contest.status === 'CANCELLED') return null
  const seed = contest.status === 'DRAWN' ? (contest.seed ?? null) : null
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t('events.fairness.title')}</summary>
      <div className="mt-2 space-y-1">
        <p>{seed === null ? t('events.fairness.before') : t('events.fairness.after')}</p>
        {seed !== null ? <code className="block break-all font-mono text-foreground">{seed}</code> : null}
        <code className="block break-all font-mono">SHA-256: {hash}</code>
      </div>
    </details>
  )
}
