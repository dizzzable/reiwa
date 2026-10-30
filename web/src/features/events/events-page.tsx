import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import { BarChart3, CheckCircle2, ExternalLink, Gift, PartyPopper, Sparkles, Ticket, Trophy, Users } from 'lucide-react'

import {
  enterContest,
  getContests,
  type ContestLeaderboardView,
  type ContestMetric,
  type ContestView,
} from '@/lib/api-client'
import { BackButton } from '@/components/ui/back-button'
import { StadiumButton } from '@/components/ui/stadium-button'
import { PrizeBurst } from '@/features/wheel/components/prize-burst'
import { pickLocalized } from '@/lib/pick-localized'
import { cn, formatDateTime, getActiveLocale, openExternalUrl } from '@/lib/utils'

/**
 * Contests: what is running, how the person did, and who won.
 *
 * Contests only. The wheel is a different mechanic with an icon of its own
 * on the dashboard (the owner, 30.10.2026); it used to have a card here and
 * one icon led to both. A contest is a window, a list of
 * prizes, a button — the conditions, when there are any (a channel to join,
 * tickets for paying and for friends who pay) — and, once the draw has run,
 * this person's own result and the winners with their names masked (the
 * owner, 29.10.2026: everybody should see that a draw went to real people).
 * Who else entered and anybody's odds are not on this screen.
 *
 * A leaderboard (30.10.2026) has no button: everybody in its audience is on
 * it. The card shows the top with names masked, where this person stands,
 * and how much more takes a prize place.
 *
 * Motion is the cabinet's own: cards and rows rise in one after another, the
 * way the activity feed does, and the bar to a prize place fills. There is no
 * app-wide `MotionConfig` to silence any of it, so each piece asks
 * `useReducedMotion` itself and simply arrives where it ends.
 *
 * Colour follows the operator's theme, which may be light. Surfaces, text and
 * borders are theme tokens. The brand colour is never the text itself, and
 * what is drawn in it on a card — icons, dots, rings, the bar — is
 * `--brand-ink`, the primary moved toward the text colour where the theme's
 * own primary would vanish (lib/brand-ink.ts). Only the button keeps the bare
 * primary: it is a fill, with `primaryFg` on it — edged in the ink, for the
 * theme whose card is the primary. Amber and the medals are the only
 * fixed colours, and each has a darker shade for a light scheme — `dark:`
 * here is the `.dark` class the branding sets from the background.
 */
export default function EventsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // Where to join, for a contest whose entry Telegram has just refused.
  const [joinUrls, setJoinUrls] = useState<Readonly<Record<string, string>>>({})

  const contests = useQuery({ queryKey: ['contests'], queryFn: getContests })

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
        <h1 className="theme-title text-2xl font-bold">{t('events.title')}</h1>
        <p className="theme-muted mt-1 text-sm">{t('events.subtitle')}</p>
      </header>

      {contests.isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1].map((index) => (
            <div key={index} className="theme-skeleton h-40 rounded-[var(--radius-card)] motion-safe:animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="theme-muted flex flex-col items-center gap-3 py-16 text-center">
          <Trophy className="h-10 w-10 opacity-30" />
          <p className="text-sm">{t('events.empty')}</p>
        </div>
      ) : null}

      {running.length > 0 ? (
        <section className="space-y-3">
          <h2 className="theme-muted text-sm font-medium">{t('events.running')}</h2>
          {running.map((contest, index) => (
            <ContestCard
              key={contest.id}
              contest={contest}
              order={index}
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
          <h2 className="theme-muted text-sm font-medium">{t('events.finished')}</h2>
          {finished.map((contest, index) => (
            <ContestCard
              key={contest.id}
              contest={contest}
              order={running.length + index}
              entering={false}
              joinUrl={null}
              onEnter={() => undefined}
            />
          ))}
        </section>
      ) : null}
    </div>
  )
}

/** The cabinet's settle curve — the one `StepTransition` moves on. */
const EASE = [0.22, 1, 0.36, 1] as const

/**
 * Gold, silver, bronze for the first three places — a look, like the wheel's
 * rarities. A shade per scheme: the pale gold that reads on a dark card is
 * lost on a white one.
 */
const MEDALS: Readonly<Record<number, { readonly text: string; readonly fill: string }>> = {
  1: { text: 'text-amber-600 dark:text-amber-400', fill: 'bg-amber-500/15' },
  2: { text: 'text-slate-500 dark:text-slate-300', fill: 'bg-slate-400/20' },
  3: { text: 'text-orange-700 dark:text-orange-400', fill: 'bg-orange-500/15' },
}
const NO_MEDAL = 'theme-muted'

/** Amber for icons and owed-prize notes, readable on either scheme. */
const AMBER_ICON = 'text-amber-600 dark:text-amber-400'
const AMBER_TEXT = 'text-amber-700 dark:text-amber-400'

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
  order,
  entering,
  joinUrl,
  onEnter,
}: {
  readonly contest: ContestView
  /** Where the card stands on the page, so the cards rise in one after another. */
  readonly order: number
  readonly entering: boolean
  /** Set when Telegram refused the entry for want of the channel. */
  readonly joinUrl: string | null
  readonly onEnter: () => void
}) {
  const { t, i18n } = useTranslation()
  const reduceMotion = useReducedMotion() === true
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
    <motion.article
      className="glass-card relative overflow-hidden p-4"
      data-testid="contest-card"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(order, 6) * 0.05, ease: EASE }}
    >
      {contest.status === 'DRAWN' ? <Celebration contest={contest} /> : null}

      {/* Positioned, so it paints over the celebration's light and not under it. */}
      <div className="relative space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-item)] bg-(--brand-ink)/12 text-(--brand-ink)">
            {board === null ? <Gift className="h-5 w-5" /> : <BarChart3 className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="theme-title flex items-center gap-2 font-semibold">
              <span className="min-w-0 break-words">{title}</span>
              {live && starts.getTime() <= now ? <LiveDot /> : null}
            </h3>
            {description ? (
              <p className="theme-muted mt-1 whitespace-pre-line text-sm">{description}</p>
            ) : null}
          </div>
        </div>

        <div className="theme-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
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

        <ul className="space-y-1.5 text-sm">
          {contest.prizes.map((prize) => (
            <li key={prize.place} className="flex items-center gap-2">
              <Trophy className={cn('h-4 w-4 shrink-0', MEDALS[prize.place]?.text ?? NO_MEDAL)} />
              <span className="theme-muted">
                {prize.placeTo != null && prize.placeTo > prize.place
                  ? t('events.placeRange', { from: prize.place, to: prize.placeTo })
                  : t('events.place', { place: prize.place })}
              </span>
              <span className="theme-title">{pickLocalized(prize.title, i18n.language, t('events.unnamed'))}</span>
            </li>
          ))}
        </ul>

        {board !== null ? <Leaderboard board={board} live={live} /> : null}

        {live && board === null ? <Conditions contest={contest} channelUrl={channelUrl} /> : null}

        {contest.status === 'CANCELLED' ? (
          <p className="theme-muted text-sm">{t('events.cancelled')}</p>
        ) : contest.status === 'DRAWN' ? (
          <>
            {contest.entered || contest.myResult !== null ? <Result contest={contest} /> : null}
            {board === null ? <Winners contest={contest} /> : null}
          </>
        ) : board !== null ? (
          contest.closed === 'NOT_ELIGIBLE' ? (
            <p className="theme-muted text-sm">{t('events.refusal.NOT_ELIGIBLE')}</p>
          ) : null
        ) : contest.entered ? (
          // Springs in where the button was, so the tap visibly lands.
          <motion.p
            className="theme-title flex items-center gap-2 rounded-[var(--radius-item)] border border-(--brand-ink)/35 bg-(--brand-ink)/10 px-3 py-2.5 text-sm font-medium"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 26 }}
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-(--brand-ink)" />
            {t('events.youAreIn')}
          </motion.p>
        ) : contest.closed !== null ? (
          <p className="theme-muted text-sm">
            {t(`events.refusal.${contest.closed}`, t('events.refusal.NOT_OPEN'))}
          </p>
        ) : (
          <StadiumButton
            // The inset ring is the ink: the same colour as the fill wherever
            // the primary stands out, so it disappears into it, and a darker
            // edge where the theme paints the card in the primary itself.
            className="w-full ring-1 ring-(--brand-ink)/45 ring-inset"
            // The breathing halo is one of the cabinet's animations the
            // system setting does not reach, so it is asked here instead.
            glow={!reduceMotion && !entering}
            loading={entering}
            icon={<Sparkles className="h-4 w-4" />}
            onClick={onEnter}
          >
            {t('events.enter')}
          </StadiumButton>
        )}

        <Fairness contest={contest} />
      </div>
    </motion.article>
  )
}

/** A running contest's pulse beside its title. Holds still when motion is turned down. */
function LiveDot() {
  return (
    <span aria-hidden className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inline-flex h-full w-full rounded-full bg-(--brand-ink) opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-(--brand-ink)" />
    </span>
  )
}

const CELEBRATED_KEY = 'reiwa:contests-celebrated:v1'

/** True the first time this device shows this contest's win. Storage that fails says «not the first». */
function firstLookAt(contestId: string): boolean {
  try {
    const seen: unknown = JSON.parse(window.localStorage.getItem(CELEBRATED_KEY) ?? '[]')
    return !(Array.isArray(seen) && seen.includes(contestId))
  } catch {
    return false
  }
}

function rememberLook(contestId: string): void {
  try {
    const seen: unknown = JSON.parse(window.localStorage.getItem(CELEBRATED_KEY) ?? '[]')
    const ids = Array.isArray(seen) ? seen.filter((id): id is string => typeof id === 'string') : []
    if (ids.includes(contestId)) return
    // The last fifty are plenty: a contest is not won twice a week.
    window.localStorage.setItem(CELEBRATED_KEY, JSON.stringify([...ids, contestId].slice(-50)))
  } catch {
    // Private mode or storage refused: the party simply comes back next time.
  }
}

/**
 * The wheel's burst over a won contest — once per device, the first time the
 * result is seen; after that the card just says it. A prize still owed gets
 * the light without the confetti, as on the wheel; a refused one gets nothing.
 *
 * «Seen» means scrolled into sight, not mounted: a finished contest sits
 * below the running ones, and a burst that went off out of view would be
 * spent on nobody. motion's `useInView` assumes an IntersectionObserver
 * exists; an old WebView (and jsdom) has none, and there the card celebrates
 * where it stands.
 */
function Celebration({ contest }: { readonly contest: ContestView }) {
  const result = contest.myResult
  const [due] = useState(() => result !== null && result.status !== 'REFUSED' && firstLookAt(contest.id))
  const area = useRef<HTMLDivElement>(null)
  const [inSight, setInSight] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = area.current
    if (!due || inSight || node === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        setInSight(true)
      },
      { threshold: 0.4 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [due, inSight])
  useEffect(() => {
    if (due && inSight) rememberLook(contest.id)
  }, [due, inSight, contest.id])
  if (!due || result === null) return null
  return (
    <div ref={area} aria-hidden className="pointer-events-none absolute inset-0">
      {inSight ? <PrizeBurst rarity="LEGENDARY" spinId={contest.id} muted={result.status === 'PENDING'} /> : null}
    </div>
  )
}

/** What the contest asks beyond the button: its channel, and what earns tickets. */
function Conditions({ contest, channelUrl }: { readonly contest: ContestView; readonly channelUrl: string | null }) {
  const { t } = useTranslation()
  const tickets = contest.tickets ?? null
  if (channelUrl === null && tickets === null) return null
  return (
    <div className="theme-surface-high space-y-2 rounded-[var(--radius-item)] p-3 text-sm">
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
            <Ticket className={cn('h-4 w-4 shrink-0', AMBER_ICON)} />
            {t('events.tickets.mine', { count: tickets.mine })}
          </p>
          <ul className="theme-muted space-y-0.5 text-xs">
            {tickets.perPurchase > 0 ? <li>{t('events.tickets.perPurchase', { count: tickets.perPurchase })}</li> : null}
            {tickets.perReferral > 0 ? <li>{t('events.tickets.perReferral', { count: tickets.perReferral })}</li> : null}
            {tickets.max !== null ? <li>{t('events.tickets.max', { count: tickets.max })}</li> : null}
          </ul>
          <p className="theme-muted text-xs">{t('events.tickets.hint')}</p>
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
  const reduceMotion = useReducedMotion() === true
  const result = contest.myResult
  if (result === null) {
    // A leaderboard says this person's place on the board itself; «не
    // повезло» is a draw's word, not a ranking's.
    if (contest.kind === 'LEADERBOARD') return null
    return <p className="theme-muted text-sm">{t('events.result.notThisTime')}</p>
  }
  const secret = result.prize?.key ?? result.prize?.promoCode ?? null
  return (
    <motion.div
      className="space-y-1 rounded-[var(--radius-item)] border border-amber-500/40 bg-amber-400/15 p-3 text-sm dark:border-amber-400/30 dark:bg-amber-400/10"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 24, delay: 0.15 }}
    >
      <p className="theme-title flex items-center gap-2 font-medium">
        <PartyPopper className={cn('h-4 w-4 shrink-0', AMBER_ICON)} />
        {t('events.result.won', {
          place: result.place,
          prize: pickLocalized(result.prizeTitle, i18n.language, t('events.unnamed')),
        })}
      </p>
      {secret ? <p className="theme-title break-all font-mono">{secret}</p> : null}
      {result.status === 'PENDING' && result.held === true && result.ticketId === null ? (
        <p className={cn('text-xs', AMBER_TEXT)}>{t('events.result.held')}</p>
      ) : result.status === 'PENDING' ? (
        <p className={cn('text-xs', AMBER_TEXT)}>
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
        <p className="theme-muted text-xs">{t('events.result.refused')}</p>
      ) : null}
    </motion.div>
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

/** A place in a circle, gold, silver and bronze for the first three. */
function RankBadge({ rank }: { readonly rank: number }) {
  const medal = MEDALS[rank]
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums',
        medal === undefined ? NO_MEDAL : [medal.text, medal.fill],
      )}
    >
      {rank}
    </span>
  )
}

/**
 * The board: what it ranks by, the top with names masked — this person's
 * own row marked — their place when it is below the top, and while it runs
 * how much more takes a prize place, as words and as a bar that fills.
 */
function Leaderboard({ board, live }: { readonly board: ContestLeaderboardView; readonly live: boolean }) {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion() === true
  const score = useScore()
  const say = (value: number) => score(board.metric, value, board.currency)
  const mineInTop = board.top.some((row) => row.me)
  return (
    <div className="theme-surface-high space-y-2 rounded-[var(--radius-item)] p-3 text-sm" data-testid="contest-leaderboard">
      {board.metric !== null ? (
        <p className="theme-title flex items-center gap-2 font-medium">
          <BarChart3 className={cn('h-4 w-4 shrink-0', AMBER_ICON)} />
          {t(`events.board.metric.${board.metric}`)}
        </p>
      ) : null}
      {live ? <p className="theme-muted text-xs">{t('events.board.everyone')}</p> : null}
      {board.top.length === 0 ? (
        <p className="theme-muted text-xs">{t('events.board.empty')}</p>
      ) : (
        <ol className="space-y-0.5">
          {board.top.map((row, index) => (
            <motion.li
              key={row.rank}
              className={cn(
                'flex items-center justify-between gap-2 rounded-[var(--radius-item)] px-1.5 py-1',
                row.me && 'theme-title bg-(--brand-ink)/12 font-semibold ring-1 ring-(--brand-ink)/40 ring-inset',
              )}
              initial={reduceMotion ? false : { opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: 0.12 + Math.min(index, 10) * 0.03, ease: EASE }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <RankBadge rank={row.rank} />
                <span className="truncate">
                  {row.me ? t('events.board.you') : (row.name ?? t('events.winnerAnon'))}
                </span>
              </span>
              <span className="shrink-0 tabular-nums">{say(row.score)}</span>
            </motion.li>
          ))}
        </ol>
      )}
      {board.mine !== null && !mineInTop ? (
        <p className="theme-title font-medium" data-testid="contest-my-place">
          {t('events.board.mine', { rank: board.mine.rank, score: say(board.mine.score) })}
        </p>
      ) : null}
      {live && board.mine === null ? <p className="theme-muted text-xs">{t('events.board.notYet')}</p> : null}
      {live && board.toPrize !== null ? (
        <div className="space-y-1.5">
          {board.mine !== null ? (
            <PrizeBar share={board.toPrize === 0 ? 1 : board.mine.score / (board.mine.score + board.toPrize)} />
          ) : null}
          <p className="text-xs" data-testid="contest-to-prize">
            {board.toPrize === 0 ? t('events.board.holding') : t('events.board.toPrize', { amount: say(board.toPrize) })}
          </p>
        </div>
      ) : null}
      {board.minScore !== null && board.minScore > 0 ? (
        <p className="theme-muted text-xs">{t('events.board.minScore', { amount: say(board.minScore) })}</p>
      ) : null}
    </div>
  )
}

/**
 * How far along to a prize place: the person's score against the score that
 * takes one. Decoration beside the words, which say the same — so it is
 * hidden from screen readers rather than read out twice.
 */
function PrizeBar({ share }: { readonly share: number }) {
  const reduceMotion = useReducedMotion() === true
  const width = `${Math.round(Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0)) * 100)}%`
  return (
    <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-(--brand-ink)/15">
      <motion.div
        className="h-full rounded-full bg-(--brand-ink)"
        initial={reduceMotion ? false : { width: 0 }}
        animate={{ width }}
        transition={{ duration: 0.8, delay: 0.25, ease: EASE }}
      />
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
      <p className="theme-muted text-xs font-medium">{t('events.winnersTitle')}</p>
      <ul className="space-y-1 text-sm" data-testid="contest-winners">
        {winners.map((winner) => (
          <li key={winner.place} className="flex items-center gap-2">
            <Trophy className={cn('h-3.5 w-3.5 shrink-0', MEDALS[winner.place]?.text ?? NO_MEDAL)} />
            <span className="theme-muted">{t('events.place', { place: winner.place })}</span>
            <span className="theme-title font-medium">{winner.name ?? t('events.winnerAnon')}</span>
            <span className="theme-muted">— {pickLocalized(winner.prizeTitle, i18n.language, t('events.unnamed'))}</span>
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
    <details className="theme-muted text-xs">
      <summary className="cursor-pointer select-none">{t('events.fairness.title')}</summary>
      <div className="mt-2 space-y-1">
        <p>{seed === null ? t('events.fairness.before') : t('events.fairness.after')}</p>
        {seed !== null ? <code className="theme-title block break-all font-mono">{seed}</code> : null}
        <code className="block break-all font-mono">SHA-256: {hash}</code>
      </div>
    </details>
  )
}
