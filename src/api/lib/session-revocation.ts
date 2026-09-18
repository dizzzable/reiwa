/**
 * The cabinet's question to the panel: "was this customer signed out
 * everywhere, and when?" — asked by the session middleware at most once a
 * minute per session (`SESSION_REVOCATION_CHECK_INTERVAL_MS`), and only for
 * requests to the API (`isRevocationCheckedPath`); and asked AFRESH, with no
 * minute of grace, before a money or credential action (`fresh-session-check.ts`).
 *
 * The panel keeps the moment in Postgres (`web_accounts.sessions_revoked_at`),
 * written by a password reset, a password change, a first password, an
 * operator's temporary password and «Выйти на всех устройствах». Every session
 * that started before it is signed out.
 *
 * ONE CLOCK. The moment is on the panel's clock; a session's start is on this
 * server's. Two servers disagree by seconds, sometimes by more — at ±30 s a
 * session opened just before a sign-out survived it, and one opened just after
 * was ended by it, again and again for the Mini App that re-opens its session.
 * The panel therefore answers with its `now`, and every answer here carries the
 * estimated difference between the two clocks (`panelOffsetMs`): the panel's
 * `now` against the middle of the round trip, off by at most half the round
 * trip — the deadline bounds that at a second, a healthy link at milliseconds.
 *
 * The background question never signs a session out on its own authority. An
 * answer the panel could not give — it is down, slow, or older than the
 * question — is `null`, "could not tell", and the session carries on: a cabinet
 * deployed ahead of its panel revokes nothing and breaks nothing. An older
 * panel answers that it has no such ROUTE (`isUpstreamMissingRoute`: the
 * status and the body of its own error filter, never message text); after one,
 * this cabinet stops asking for `OLDER_PANEL_BACKOFF_MS`, so a cabinet upgraded
 * first does not add a request per session per minute to a panel that cannot
 * answer it. Any other 404 — a proxy's page while the panel restarts — is a
 * failure like any other and silences nobody. A panel that does not answer
 * within `REVOCATION_ANSWER_DEADLINE_MS` is not waited for: the request the
 * question rides on carries on, and the session is asked again at its next
 * interval.
 */
import type { LoggerPort } from "../../application/ports/logger.port.js";
import type { SessionRevocationCheck } from "../../infrastructure/redis/session.js";
import type { WebSessionsStateResult } from "../../infrastructure/admin-client/namespaces/web-auth.js";
import { isUpstreamMissingRoute } from "./upstream-error.js";

/** How long an older panel (its route missing) is left alone before it is asked again. */
export const OLDER_PANEL_BACKOFF_MS = 2 * 60_000;

/**
 * How long a request waits for the panel's answer. The question rides on a
 * customer's request once a minute, so a panel that hangs must not hang that
 * request for the transport's full timeout.
 */
export const REVOCATION_ANSWER_DEADLINE_MS = 2_000;

/**
 * How long the question asked before a money or credential action waits. That
 * one refuses when there is no answer, so it waits longer than the background
 * one, which lets the request through.
 */
export const FRESH_ANSWER_DEADLINE_MS = 5_000;

/**
 * Which requests carry the question: the API's. A static file or the page
 * shell decides nothing about the customer, and an asset request must never
 * wait on the panel.
 */
export function isRevocationCheckedPath(path: string): boolean {
  return path.startsWith("/api/");
}

export interface SessionStateSource {
  sessionsState(userId: string): Promise<WebSessionsStateResult>;
}

/**
 * What the panel said. `revokedAt` is its moment in ms on ITS clock (`null`:
 * nothing ever revoked); `panelOffsetMs` is its clock minus this server's.
 */
export interface PanelRevocationState {
  readonly revokedAt: number | null;
  readonly panelOffsetMs: number;
}

export type SessionStateAnswer =
  | { readonly kind: "answered"; readonly state: PanelRevocationState }
  /** The panel has no such route: it predates the sign-out, so nothing of this customer was ever revoked by it. */
  | { readonly kind: "older-panel" }
  /** The panel could not say. */
  | { readonly kind: "unknown"; readonly reason: "timeout" | "failed" | "malformed" };

export interface AskSessionStateOptions {
  readonly logger?: LoggerPort;
  readonly clock?: () => number;
  readonly deadlineMs?: number;
}

const TIMED_OUT = Symbol("timed out");

/** Asks the panel once, within the deadline, and reads the answer onto this server's clock. */
export async function askSessionState(
  webAuth: SessionStateSource,
  userId: string,
  options: AskSessionStateOptions = {},
): Promise<SessionStateAnswer> {
  const { logger, clock = Date.now, deadlineMs = REVOCATION_ANSWER_DEADLINE_MS } = options;
  const sentAt = clock();
  const asked = webAuth.sessionsState(userId);
  // A late answer or a late failure after the deadline has nobody waiting
  // for it; it must not surface as an unhandled rejection.
  asked.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deadlineMs);
    timer.unref?.();
  });
  let state: WebSessionsStateResult | typeof TIMED_OUT;
  try {
    state = await Promise.race([asked, deadline]);
  } catch (err: unknown) {
    if (isUpstreamMissingRoute(err)) return { kind: "older-panel" };
    logger?.warn({ err, component: "SessionRevocation" }, "the panel did not say whether the session was signed out");
    return { kind: "unknown", reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
  if (state === TIMED_OUT) {
    logger?.warn({ component: "SessionRevocation", deadlineMs }, "the panel did not answer in time whether the session was signed out");
    return { kind: "unknown", reason: "timeout" };
  }
  const receivedAt = clock();
  const revokedAt = state.sessionsRevokedAt === null ? null : Date.parse(state.sessionsRevokedAt);
  if (revokedAt !== null && Number.isNaN(revokedAt)) return { kind: "unknown", reason: "malformed" };
  // A panel that sends no clock is taken to agree with this one — the only
  // reading there is, and the one every cabinet before this made.
  const panelNow = typeof state.now === "string" ? Date.parse(state.now) : Number.NaN;
  const panelOffsetMs = Number.isNaN(panelNow) ? 0 : Math.round(panelNow - (sentAt + receivedAt) / 2);
  return { kind: "answered", state: { revokedAt, panelOffsetMs } };
}

export interface SessionRevocationCheckOptions {
  readonly logger?: LoggerPort;
  readonly clock?: () => number;
  readonly deadlineMs?: number;
}

/** The background question: `null` whenever the panel could not tell — nobody is signed out on a guess. */
export function createSessionRevocationCheck(
  webAuth: SessionStateSource,
  options: SessionRevocationCheckOptions = {},
): SessionRevocationCheck {
  const { logger, clock = Date.now, deadlineMs = REVOCATION_ANSWER_DEADLINE_MS } = options;
  let silentUntil = 0;
  return async (userId) => {
    if (clock() < silentUntil) return null;
    const answer = await askSessionState(webAuth, userId, { logger, clock, deadlineMs });
    if (answer.kind === "older-panel") {
      silentUntil = clock() + OLDER_PANEL_BACKOFF_MS;
      return null;
    }
    return answer.kind === "answered" ? answer.state : null;
  };
}
