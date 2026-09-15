/**
 * «Канал обязателен» in the Telegram Mini App.
 *
 * The bot refuses to go past `/start` until Telegram confirms the user is in
 * the operator's channel; the Mini App used to open the whole cabinet anyway.
 * This gate closes that: inside a Mini App, once there is a session, every
 * cabinet route is replaced by `ChannelGateScreen` for as long as the server
 * answers `not-subscribed`. Everyone is asked the same way, paying subscribers
 * included.
 *
 * ── Only a Mini App, and only a `not-subscribed` ────────────────────────────
 *
 * In a plain browser `ChannelGate` renders its children and nothing else: no
 * session read, no request, no extra element. The surface is decided by
 * `isTelegramMiniAppSurface()`, which reads Telegram's launch parameters off
 * the URL, the in-memory capture and the SDK's session mirror before it looks
 * at the bridge — so a reload that has lost the fragment is still recognised,
 * and so is a customer whose network cannot reach telegram.org.
 *
 * ── The first answer lets the user in on any doubt ──────────────────────────
 *
 * `off`, `subscribed` and `unverified` open the cabinet, and so does any
 * failure to get the first answer: an error, and an answer that has not
 * arrived within `CHANNEL_GATE_ANSWER_BUDGET_MS` of the session appearing.
 * That opening is final for the account — an answer that lands after the
 * cabinet has been shown is dropped, because a wall thrown over a cabinet the
 * user is already using is worse than the gate missing one launch. The one
 * exception is a 401: the session is refreshed, and when it comes back the
 * account is asked again.
 *
 * The verdict belongs to an ACCOUNT — the panel's `id`, else the Telegram id
 * (`channelGateAccountKey`) — not to the document: signing in to a different
 * account inside the same Mini App asks again. Every ask carries its own
 * number, and anything that answers an earlier ask is dropped, so a quick
 * A → B → A cannot land A's first answer on A's second ask.
 *
 * ── A re-check that fails keeps the wall ────────────────────────────────────
 *
 * Once the user has been found not subscribed, «✅ Я подписался» and the
 * automatic re-check can only take the wall DOWN on an answer; a failure
 * leaves it up, because what is known is still "not subscribed":
 *   - 401: the session is gone. The session query is refreshed, so the app's
 *     own session handling takes over (`StealthLayout` → `/bootstrap` → a
 *     fresh Telegram sign-in) instead of a bounce to a password form.
 *   - 429: no check is sent until the wall clock reaches the end of the hold;
 *     a press in that time is told how long is left. The end is a time, not a
 *     timer: a phone that slept through it finds the hold over on the next tick
 *     or the next return, not a countdown gone negative.
 *   - anything else, or no answer within `CHANNEL_GATE_CHECK_BUDGET_MS`: the
 *     failure text, and the button is available again.
 * Only a press is answered in words. The automatic re-check never writes to
 * the live region — no "checking" line, no result — and all it may do on its
 * own is let the user in, or quietly clear a failure it has just disproved. A
 * press that lands while it is out makes it the user's: its answer is spoken,
 * and it gets a budget of its own.
 *
 * ── Coming back from Telegram ───────────────────────────────────────────────
 *
 * The user goes to Telegram to join and comes back; the gate asks again
 * without a press. "Came back" is not one signal on every client: the document
 * becoming visible, a restore from the back/forward cache, the window regaining
 * focus (Telegram Desktop keeps the Mini App window visible while the channel
 * opens), and the bridge's own `activated` (a phone webview that never reports
 * itself hidden). All four share one budget of their own — at most one
 * automatic re-check per `CHANNEL_GATE_RETURN_RECHECK_GAP_MS`, none within
 * `CHANNEL_GATE_AFTER_PRESS_QUIET_MS` of a press — because the server allows an
 * account ten checks a minute and a focus that spent them would leave a press
 * with a 429. All of them are dropped the moment the wall is.
 *
 * ── No flash of the cabinet ─────────────────────────────────────────────────
 *
 * On a gated route nothing of the cabinet renders until the gate has decided:
 * while the session is still being read, and while the first answer is on its
 * way, the caller's `fallback` — the app's full-screen loader — stands in.
 *
 * ── Routes the gate does not cover ──────────────────────────────────────────
 *
 * `CHANNEL_GATE_EXEMPT_PATHS`, decided from `App.tsx` and re-read on every
 * navigation; everything else is gated, including a route added later, which
 * is the safe default for "the WHOLE cabinet":
 *   - `/`, `/tma`, `/bootstrap` — the Mini App's sign-in handshake. They render
 *     a splash or an error and always finish by navigating to a cabinet route,
 *     which is gated. `/tma` is the one that CREATES the session: gating it
 *     would swap the page out from under its own bootstrap the moment the
 *     session appears, and hide its error and rate-limit screens behind a
 *     loader.
 *   - `/payment-return` — a buyer back from the payment provider, whose page is
 *     polling the payment and carries the "Open payment" button that is the
 *     gesture-carrying way through checkout inside a Mini App. The bot makes
 *     the same exception for its `payment_return` start. When the page is done
 *     it goes to `/dashboard`, and the gate is there.
 *   - `/legal` — the operator's public documents: readable by anyone without an
 *     account, linked from the bot and from the sign-up form, and holding
 *     nothing of the cabinet.
 *
 * The check itself still runs on those routes; only the screen waits.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { matchPath, useLocation } from "react-router";

import { SESSION_QUERY_KEY, useSession } from "@/hooks/use-session";
import { useTelegramWebApp } from "@/hooks/use-telegram-webapp";
import {
  checkChannelGate,
  getChannelGate,
  readChannelGateFailure,
  type ChannelGateAnswer,
  type ChannelGateFailure,
} from "@/lib/api-client";
import { isTelegramMiniAppSurface } from "@/lib/telegram-launch-params";
import type { ReiwaSession } from "@/types/api";

import { ChannelGateScreen, type ChannelGateNotice } from "./channel-gate-screen";

/** How long the first answer is waited for, from the moment the session appears. */
export const CHANNEL_GATE_ANSWER_BUDGET_MS = 6_000;

/**
 * How long a re-check is waited for before it counts as failed. The server's
 * path to Telegram can take twenty seconds and more; a button spinning that long
 * reads as a dead screen.
 */
export const CHANNEL_GATE_CHECK_BUDGET_MS = 10_000;

/** The shortest time between two automatic re-checks. */
export const CHANNEL_GATE_RETURN_RECHECK_GAP_MS = 20_000;

/** How long after a press no automatic re-check is sent. */
export const CHANNEL_GATE_AFTER_PRESS_QUIET_MS = 10_000;

/** Paths that render whatever the gate has concluded. Why each: see the file header. */
export const CHANNEL_GATE_EXEMPT_PATHS: readonly string[] = [
  "/",
  "/tma",
  "/bootstrap",
  "/payment-return",
  "/legal",
];

/** Matched the way the router matches: whole path, trailing slash and case tolerated. */
export function isChannelGateExemptPath(pathname: string): boolean {
  return CHANNEL_GATE_EXEMPT_PATHS.some((path) => matchPath({ path, end: true }, pathname) !== null);
}

/**
 * Which account a session is. The panel's payload — what `/session` passes
 * through — carries `id` and `telegramId` and never `userId`; the legacy
 * session the route falls back to carries `telegramId` and no `id`. See
 * `ReiwaSession`.
 */
export function channelGateAccountKey(session: ReiwaSession): string {
  if (typeof session.id === "string" && session.id.length > 0) return `id:${session.id}`;
  if (typeof session.telegramId === "string" && session.telegramId.length > 0) {
    return `telegram:${session.telegramId}`;
  }
  return "session";
}

type CheckOrigin = "manual" | "automatic";

interface WalledState {
  readonly phase: "walled";
  readonly joinUrl: string | null;
  /** The check in flight, if any, and whose it is. */
  readonly check: CheckOrigin | null;
  readonly notice: ChannelGateNotice | null;
  /** Until when (epoch ms) no check is sent, after a 429. */
  readonly retryAt: number | null;
  /** The wait the user was told about when the rate-limit notice went up, in seconds. */
  readonly toldSeconds: number | null;
}

type GateState = { readonly phase: "undecided" } | { readonly phase: "open" } | WalledState;

/** Everything the gate knows about the account it is asking about — the one copy there is. */
interface GateStore {
  readonly subject: string | null;
  /** Which ask this is. Anything carrying another number is about an earlier one. */
  readonly ask: number;
  readonly gate: GateState;
  /** When the last automatic re-check went out (epoch ms). */
  readonly lastAutomaticAt: number | null;
  /** When the user last pressed a re-check out, or took one over (epoch ms). */
  readonly lastPressAt: number | null;
}

type GateEvent = { readonly ask: number } & (
  /** A first answer is being asked for this account. */
  | { readonly type: "asked"; readonly subject: string }
  /** The first answer, in time. */
  | { readonly type: "answered"; readonly answer: ChannelGateAnswer }
  /** The first answer failed, or did not come within the budget. */
  | { readonly type: "unanswered" }
  | { readonly type: "check-started"; readonly origin: CheckOrigin; readonly at: number }
  /** A press landed while the automatic check was out. */
  | { readonly type: "check-taken-over" }
  | { readonly type: "check-answered"; readonly answer: ChannelGateAnswer }
  | { readonly type: "check-failed"; readonly failure: ChannelGateFailure; readonly retryAt: number | null }
  /** A press landed while checks are held back after a 429. */
  | { readonly type: "held-back"; readonly toldSeconds: number }
  /** The hold after a 429 has run out. */
  | { readonly type: "hold-over" }
);

const UNDECIDED: GateState = { phase: "undecided" };
const OPEN: GateState = { phase: "open" };
const INITIAL_STORE: GateStore = { subject: null, ask: 0, gate: UNDECIDED, lastAutomaticAt: null, lastPressAt: null };

function walledBy(joinUrl: string | null): WalledState {
  return { phase: "walled", joinUrl, check: null, notice: null, retryAt: null, toldSeconds: null };
}

function reduceChannelGate(store: GateStore, event: GateEvent): GateStore {
  if (event.type === "asked") {
    return { subject: event.subject, ask: event.ask, gate: UNDECIDED, lastAutomaticAt: null, lastPressAt: null };
  }
  // An earlier ask — this account's previous one, or another account's. Its
  // answer is not about the account being asked now.
  if (event.ask !== store.ask) return store;
  const { gate } = store;
  if (event.type === "answered") {
    return { ...store, gate: event.answer.status === "not-subscribed" ? walledBy(event.answer.joinUrl) : OPEN };
  }
  if (event.type === "unanswered") return { ...store, gate: OPEN };
  if (gate.phase !== "walled") return store;
  const manual = gate.check === "manual";
  switch (event.type) {
    case "check-started":
      return {
        ...store,
        gate: { ...gate, check: event.origin },
        lastAutomaticAt: event.origin === "automatic" ? event.at : store.lastAutomaticAt,
        lastPressAt: event.origin === "manual" ? event.at : store.lastPressAt,
      };
    case "check-taken-over":
      // No `lastPressAt` here: a take-over lands within the automatic check's
      // ten-second budget, so the twenty seconds since that check went out
      // already outlast the quiet a press would start.
      return gate.check === "automatic" ? { ...store, gate: { ...gate, check: "manual" } } : store;
    case "check-answered":
      if (event.answer.status !== "not-subscribed") return { ...store, gate: OPEN };
      return {
        ...store,
        gate: {
          ...gate,
          // The operator may have changed the link while the user sat here.
          joinUrl: event.answer.joinUrl,
          check: null,
          // A press is answered in words. The automatic check says nothing, but
          // an answer is proof the earlier failure no longer holds.
          notice: manual ? "not-subscribed" : gate.notice === "failed" ? null : gate.notice,
        },
      };
    case "check-failed":
      if (event.failure.kind === "rate-limited") {
        return {
          ...store,
          gate: {
            ...gate,
            check: null,
            retryAt: event.retryAt,
            notice: manual ? "rate-limited" : gate.notice,
            toldSeconds: manual ? event.failure.retryAfterSeconds : gate.toldSeconds,
          },
        };
      }
      return { ...store, gate: { ...gate, check: null, notice: manual ? "failed" : gate.notice } };
    case "held-back":
      return { ...store, gate: { ...gate, notice: "rate-limited", toldSeconds: event.toldSeconds } };
    case "hold-over":
      return {
        ...store,
        gate: { ...gate, retryAt: null, notice: gate.notice === "rate-limited" ? null : gate.notice },
      };
  }
}

type GateView = "route" | "loader" | "wall";

/** What stands where the routes would be. One decision, read by the render AND the return listeners. */
function decideView(
  exempt: boolean,
  sessionLoading: boolean,
  authenticated: boolean,
  phase: GateState["phase"],
): GateView {
  if (exempt) return "route";
  if (sessionLoading) return "loader";
  if (!authenticated) return "route";
  if (phase === "undecided") return "loader";
  return phase === "open" ? "route" : "wall";
}

/** A bridge call inside an effect: a host-side exception must not take the app down with it. */
function callBridge(call: () => void): void {
  try {
    call();
  } catch {
    // The other three return signals still stand.
  }
}

/** A re-check that is out: what abandons it, and the timer that will. */
interface OutgoingCheck {
  readonly abandon: AbortController;
  budget: ReturnType<typeof setTimeout>;
}

function sendOut(): OutgoingCheck {
  const abandon = new AbortController();
  return { abandon, budget: setTimeout(() => abandon.abort(), CHANNEL_GATE_CHECK_BUDGET_MS) };
}

/** A check the user took over gets a whole budget, not what the automatic one had left. */
function restartBudget(check: OutgoingCheck): void {
  clearTimeout(check.budget);
  check.budget = setTimeout(() => check.abandon.abort(), CHANNEL_GATE_CHECK_BUDGET_MS);
}

interface ChannelGateProps {
  readonly children: ReactNode;
  /** The full-screen loading state, shown on a gated route until the gate decides. */
  readonly fallback: ReactNode;
}

export function ChannelGate({ children, fallback }: ChannelGateProps) {
  // Read once: whether Telegram opened this document does not change while it
  // lives, and holding the answer keeps the tree below from changing shape.
  const [miniApp] = useState(isTelegramMiniAppSurface);
  if (!miniApp) return children;
  return <MiniAppChannelGate fallback={fallback}>{children}</MiniAppChannelGate>;
}

function MiniAppChannelGate({ children, fallback }: ChannelGateProps) {
  const { session, isLoading } = useSession();
  // Passive: the root owns activating the bridge; this only listens to it.
  const { telegram } = useTelegramWebApp({ activate: false });
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const [store, dispatch] = useReducer(reduceChannelGate, INITIAL_STORE);

  // The store as of the last event, for the handlers that run between renders.
  // Written only by `send`, through the same reducer React runs — a mirror of
  // the one store, not a second copy of anything.
  const storeRef = useRef(store);
  /** Applies an event; says whether it changed anything. */
  const send = useCallback((event: GateEvent): boolean => {
    const before = storeRef.current;
    storeRef.current = reduceChannelGate(before, event);
    dispatch(event);
    return storeRef.current !== before;
  }, []);

  const subject = session === null ? null : channelGateAccountKey(session);
  const gate = store.subject === subject ? store.gate : UNDECIDED;

  const askedForRef = useRef<string | null>(null);
  const askCountRef = useRef(0);
  /** The last re-check sent out — the one out, whenever the store says one is. */
  const outgoingRef = useRef<OutgoingCheck | null>(null);

  const refreshSession = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient]);

  // The first answer, asked once per account as soon as there is one. The ref,
  // not a cleanup, is what makes it once: StrictMode's rehearsal unmount would
  // otherwise abandon the one request that goes out, and a dispatch into a
  // component that is really gone is a no-op.
  useEffect(() => {
    if (subject === null || askedForRef.current === subject) return;
    askedForRef.current = subject;
    askCountRef.current += 1;
    const ask = askCountRef.current;
    send({ type: "asked", subject, ask });
    const abandon = new AbortController();
    let settled = false;
    const settle = (event: GateEvent): boolean => {
      // First of the answer and the budget wins; the other is dropped.
      if (settled) return false;
      settled = true;
      clearTimeout(budget);
      return send(event);
    };
    const budget = setTimeout(() => {
      settle({ type: "unanswered", ask });
      abandon.abort();
    }, CHANNEL_GATE_ANSWER_BUDGET_MS);
    void (async () => {
      try {
        settle({ type: "answered", ask, answer: await getChannelGate({ signal: abandon.signal }) });
      } catch (error) {
        const unauthorized = readChannelGateFailure(error).kind === "unauthorized";
        if (settle({ type: "unanswered", ask }) && unauthorized) {
          // The session is gone, and `StealthLayout` will sign the same account
          // back in: it is asked again then, not waved through on this doubt.
          askedForRef.current = null;
          refreshSession();
        }
      }
    })();
  }, [subject, send, refreshSession]);

  /** The hold after a 429 is a time; once the wall clock is past it, it is over. */
  const endHoldIfOver = useCallback((): void => {
    const current = storeRef.current;
    if (current.gate.phase === "walled" && current.gate.retryAt !== null && Date.now() >= current.gate.retryAt) {
      send({ type: "hold-over", ask: current.ask });
    }
  }, [send]);

  /** Sends one re-check if nothing holds it back; says whether it did. */
  const runCheck = useCallback(
    (origin: CheckOrigin): boolean => {
      const current = storeRef.current;
      if (current.gate.phase !== "walled" || current.gate.check !== null) return false;
      const now = Date.now();
      if (current.gate.retryAt !== null && now < current.gate.retryAt) return false;
      if (origin === "automatic") {
        if (current.lastAutomaticAt !== null && now - current.lastAutomaticAt < CHANNEL_GATE_RETURN_RECHECK_GAP_MS) {
          return false;
        }
        if (current.lastPressAt !== null && now - current.lastPressAt < CHANNEL_GATE_AFTER_PRESS_QUIET_MS) {
          return false;
        }
      }
      const { ask } = current;
      send({ type: "check-started", ask, origin, at: now });
      const outgoing = sendOut();
      outgoingRef.current = outgoing;
      void (async () => {
        try {
          send({ type: "check-answered", ask, answer: await checkChannelGate({ signal: outgoing.abandon.signal }) });
        } catch (error) {
          const failure = readChannelGateFailure(error);
          const retryAt = failure.kind === "rate-limited" ? Date.now() + failure.retryAfterSeconds * 1000 : null;
          if (send({ type: "check-failed", ask, failure, retryAt }) && failure.kind === "unauthorized") {
            refreshSession();
          }
        } finally {
          clearTimeout(outgoing.budget);
        }
      })();
      return true;
    },
    [send, refreshSession],
  );

  /** «✅ Я подписался». Never a second request on top of one that is out. */
  const press = useCallback((): void => {
    const current = storeRef.current;
    if (current.gate.phase !== "walled") return;
    if (current.gate.check !== null) {
      // The automatic check becomes the user's, with a budget of its own; a
      // press on their own check is ignored.
      if (send({ type: "check-taken-over", ask: current.ask }) && outgoingRef.current !== null) {
        restartBudget(outgoingRef.current);
      }
      return;
    }
    endHoldIfOver();
    const held = storeRef.current.gate;
    if (held.phase === "walled" && held.retryAt !== null) {
      send({ type: "held-back", ask: current.ask, toldSeconds: Math.ceil((held.retryAt - Date.now()) / 1000) });
      return;
    }
    runCheck("manual");
  }, [send, endHoldIfOver, runCheck]);

  // While a hold lasts, a tick a second: it redraws the countdown, and it is
  // one of the moments the hold is found over. Timers stop while a phone
  // sleeps and the wall clock does not, so the countdown reads the wall clock
  // whenever it is drawn and never counts below zero.
  const heldUntil = gate.phase === "walled" ? gate.retryAt : null;
  const [, redraw] = useReducer((ticks: number) => ticks + 1, 0);
  useEffect(() => {
    if (heldUntil === null) return;
    const timer = setInterval(() => {
      redraw();
      endHoldIfOver();
    }, 1_000);
    return () => clearInterval(timer);
  }, [heldUntil, endHoldIfOver]);

  const view = decideView(isChannelGateExemptPath(pathname), isLoading, subject !== null, gate.phase);

  // Back from Telegram: ask again, without a press — only while the screen is
  // what the user is looking at.
  useEffect(() => {
    if (view !== "wall") return;
    const onReturn = (): void => {
      endHoldIfOver();
      runCheck("automatic");
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") onReturn();
    };
    // A `pageshow` that is not `persisted` is the load's own, which on a slow
    // launch can land after this screen is up: not a return.
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) onReturn();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    // Not capturing: `focus` does not bubble, but a capturing listener on the
    // window hears every element inside it take focus — the heading this
    // screen focuses, the button a keyboard user tabs to.
    window.addEventListener("focus", onReturn);
    callBridge(() => telegram?.onEvent?.("activated", onReturn));
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onReturn);
      callBridge(() => telegram?.offEvent?.("activated", onReturn));
    };
  }, [view, telegram, endHoldIfOver, runCheck]);

  if (view === "wall" && gate.phase === "walled") {
    return (
      <ChannelGateScreen
        joinUrl={gate.joinUrl}
        // Only a check the user asked for shows: the automatic one is silent.
        busy={gate.check === "manual"}
        unavailable={gate.check === "manual" || gate.notice === "rate-limited"}
        notice={gate.notice}
        toldSeconds={gate.toldSeconds}
        secondsLeft={gate.retryAt === null ? null : Math.max(0, Math.ceil((gate.retryAt - Date.now()) / 1000))}
        onCheck={press}
      />
    );
  }
  return view === "loader" ? fallback : children;
}
