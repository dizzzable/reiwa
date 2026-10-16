/**
 * connection-watch
 * ────────────────
 * Noticing that the VPN came on, so the walk can say «Подключение есть!»
 * without the customer having to come back and say so.
 *
 * ── The one signal there is, and what it cannot tell ─────────────────────────
 *
 * Remnawave keeps `onlineAt` per PROFILE: the last time any device on the
 * subscription carried traffic. The panel reads it live and stamps the answer
 * with its own clock (`checkedAt`). Two consequences shape the rule below:
 *
 *  - Nothing here compares against the phone's clock. "Did it come online
 *    after we started" is asked as "did `onlineAt` move past where it was
 *    when we started" — two readings of Remnawave's own value.
 *  - A profile already online on another device moves `onlineAt` all by
 *    itself. When the first reading shows it fresh, this device cannot be
 *    told apart from that one, and the verdict says so (`busy`) instead of
 *    guessing — the walk then asks the customer.
 *
 * `unknown` — a panel older than the walk, an outage, an unreadable answer —
 * is never "not connected" either: the walk asks the customer then too.
 */
import { useEffect, useState } from 'react'

import { getSubscriptionConnection } from '@/lib/api-client/subscription'

/** One reading of the panel's answer, in milliseconds; `null` when it could not tell. */
export interface ConnectionReading {
  readonly onlineAt: number | null
  readonly checkedAt: number
}

export type ConnectionVerdict = 'waiting' | 'connected' | 'busy' | 'unknown'

/**
 * How recent `onlineAt` has to be, at the first reading, to mean "some device
 * is using this subscription right now". Remnawave refreshes it while traffic
 * flows, so a profile in use reads seconds-to-a-minute old; three minutes
 * leaves room for a quiet connection without calling an hour-old one live.
 */
export const ONLINE_FRESH_MS = 3 * 60_000

/** How often the walk asks while it waits on «Включение». */
export const POLL_INTERVAL_MS = 4_000

/** After this long the walk stops asking and says it does not see a connection. */
export const POLL_GIVE_UP_MS = 5 * 60_000

function instant(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The BFF's answer, re-read fail-closed: anything it cannot vouch for is `null`. */
export function readConnection(payload: unknown): ConnectionReading | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const body = payload as Record<string, unknown>
  if (body['state'] !== 'known') return null
  const onlineAt = instant(body['onlineAt'])
  const checkedAt = instant(body['checkedAt'])
  if (onlineAt === undefined || checkedAt === undefined || checkedAt === null) return null
  return { onlineAt, checkedAt }
}

/**
 * THE RULE.
 *
 *   busy       the first reading saw the profile online within ONLINE_FRESH_MS
 *   connected  `onlineAt` is later than it was at the first reading
 *   waiting    neither, yet
 *   unknown    no reading at all
 */
export function connectionVerdict(
  baseline: ConnectionReading | null,
  latest: ConnectionReading | null,
): ConnectionVerdict {
  if (baseline === null) return 'unknown'
  if (baseline.onlineAt !== null && baseline.checkedAt - baseline.onlineAt < ONLINE_FRESH_MS) {
    return 'busy'
  }
  const now = latest ?? baseline
  if (now.onlineAt !== null && (baseline.onlineAt === null || now.onlineAt > baseline.onlineAt)) {
    return 'connected'
  }
  return 'waiting'
}

export interface ConnectionWatch {
  readonly verdict: ConnectionVerdict
  /** How many answers arrived while polling — «Проверили только что» once there is one. */
  readonly polls: number
  /** True once the walk has asked for long enough and stopped. */
  readonly gaveUp: boolean
}

interface WatchState {
  /** The subscription these readings are about; anything else is a fresh question. */
  readonly subscriptionId: string | null
  /** Which device of the walk this is — see `round`. */
  readonly round: number
  readonly baseline: ConnectionReading | null
  readonly latest: ConnectionReading | null
  /** Which stay on «Включение» the two below count — see `pollKey`. */
  readonly pollKey: number | null
  readonly polls: number
  readonly gaveUp: boolean
}

const EMPTY: WatchState = {
  subscriptionId: null,
  round: 0,
  baseline: null,
  latest: null,
  pollKey: null,
  polls: 0,
  gaveUp: false,
}

/** The state as it stands for this subscription — another one's readings say nothing about it. */
function forSubscription(state: WatchState, subscriptionId: string | null, round: number): WatchState {
  return state.subscriptionId === subscriptionId && state.round === round
    ? state
    : { ...EMPTY, subscriptionId, round }
}

/**
 * The baseline is taken as soon as there is a subscription — at the walk's
 * start screen, a minute or two before «Включение» — so a VPN switched on
 * during the steps between is already "later than the baseline". Polling then
 * asks every few seconds, and at once whenever the page comes back into view:
 * the customer was just in the VPN app, and that is exactly when the answer is
 * most likely to have changed. A browser throttles timers in a hidden page, so
 * the return is the moment that matters.
 *
 * `pollKey` is non-null while the walk wants answers, and a NEW value for each
 * stay on «Включение»: coming back to the step after leaving it starts the
 * count and the give-up clock over instead of resuming a stale one.
 */
export function useConnectionWatch(
  subscriptionId: string | null,
  pollKey: number | null,
  round = 0,
): ConnectionWatch {
  const [stored, setStored] = useState<WatchState>(EMPTY)

  /** One answer, folded in: the first usable reading becomes the baseline. */
  const record = (reading: ConnectionReading | null, key: number | null): void => {
    setStored((previous) => {
      const base = forSubscription(previous, subscriptionId, round)
      const counting = key !== null && base.pollKey === key
      return {
        ...base,
        // A walk whose start-screen read failed takes its baseline here, which
        // can only make it more careful: a fresh profile becomes `busy`, never
        // `connected`.
        baseline: base.baseline ?? reading,
        latest: key === null ? base.latest : (reading ?? base.latest),
        pollKey: key ?? base.pollKey,
        polls: key === null ? base.polls : (counting ? base.polls : 0) + 1,
        gaveUp: counting ? base.gaveUp : false,
      }
    })
  }

  useEffect(() => {
    if (subscriptionId === null) return
    const controller = new AbortController()
    getSubscriptionConnection(subscriptionId, controller.signal)
      .then((payload) => record(readConnection(payload), null))
      .catch(() => undefined)
    return () => controller.abort()
    // `record` closes over `subscriptionId` and `round` only, which are the dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId, round])

  useEffect(() => {
    if (pollKey === null || subscriptionId === null) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inflight: AbortController | null = null
    const startedAt = Date.now()

    const ask = (): void => {
      if (stopped) return
      if (timer !== undefined) clearTimeout(timer)
      if (Date.now() - startedAt > POLL_GIVE_UP_MS) {
        setStored((previous) => ({ ...forSubscription(previous, subscriptionId, round), pollKey, gaveUp: true }))
        return
      }
      inflight?.abort()
      const controller = new AbortController()
      inflight = controller
      getSubscriptionConnection(subscriptionId, controller.signal)
        .then((payload) => {
          if (!stopped) record(readConnection(payload), pollKey)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!stopped && inflight === controller) timer = setTimeout(ask, POLL_INTERVAL_MS)
        })
    }

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') ask()
    }
    ask()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      inflight?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey, subscriptionId, round])

  const state = forSubscription(stored, subscriptionId, round)
  const counting = pollKey !== null && state.pollKey === pollKey
  const polls = counting ? state.polls : 0
  const verdict =
    state.baseline === null && polls === 0 ? 'waiting' : connectionVerdict(state.baseline, state.latest)
  return { verdict, polls, gaveUp: counting && state.gaveUp }
}
