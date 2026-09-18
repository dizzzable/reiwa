/**
 * The cabinet's question to the panel: "was this customer signed out
 * everywhere, and when?" — asked by the session middleware at most once a
 * minute per session (`SESSION_REVOCATION_CHECK_INTERVAL_MS`), and only for
 * requests to the API (`isRevocationCheckedPath`).
 *
 * The panel keeps the moment in Postgres (`web_accounts.sessions_revoked_at`),
 * written by a password reset, a password change, a first password and «Выйти
 * на всех устройствах». Every session that started before it is signed out.
 *
 * Nothing here ever signs a session out on its own authority. An answer the
 * panel could not give — it is down, slow, or older than the question — is
 * `null`, "could not tell", and the session carries on: a cabinet deployed
 * ahead of its panel revokes nothing and breaks nothing. An older panel answers
 * 404; after one, this cabinet stops asking for `OLDER_PANEL_BACKOFF_MS`, so a
 * cabinet upgraded first does not add a request per session per minute to a
 * panel that cannot answer it. A panel that does not answer within
 * `REVOCATION_ANSWER_DEADLINE_MS` is not waited for: the request the question
 * rides on carries on, and the session is asked again at its next interval.
 */
import type { LoggerPort } from "../../application/ports/logger.port.js";
import type { SessionRevocationCheck, SessionRevocationVerdict } from "../../infrastructure/redis/session.js";
import type { WebSessionsStateResult } from "../../infrastructure/admin-client/namespaces/web-auth.js";
import { isUpstreamStatus } from "./upstream-error.js";

/** How long an older panel (404) is left alone before it is asked again. */
export const OLDER_PANEL_BACKOFF_MS = 10 * 60_000;

/**
 * How long a request waits for the panel's answer. The question rides on a
 * customer's request once a minute, so a panel that hangs must not hang that
 * request for the transport's full timeout.
 */
export const REVOCATION_ANSWER_DEADLINE_MS = 2_000;

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

export interface SessionRevocationCheckOptions {
  readonly logger?: LoggerPort;
  readonly clock?: () => number;
  readonly deadlineMs?: number;
}

const TIMED_OUT = Symbol("timed out");

export function createSessionRevocationCheck(
  webAuth: SessionStateSource,
  options: SessionRevocationCheckOptions = {},
): SessionRevocationCheck {
  const { logger, clock = Date.now, deadlineMs = REVOCATION_ANSWER_DEADLINE_MS } = options;
  let silentUntil = 0;
  return async (userId): Promise<SessionRevocationVerdict> => {
    if (clock() < silentUntil) return null;
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
      if (isUpstreamStatus(err, 404)) {
        silentUntil = clock() + OLDER_PANEL_BACKOFF_MS;
        return null;
      }
      logger?.warn({ err, component: "SessionRevocation" }, "the panel did not say whether the session was signed out");
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (state === TIMED_OUT) {
      logger?.warn({ component: "SessionRevocation", deadlineMs }, "the panel did not answer in time whether the session was signed out");
      return null;
    }
    if (state.sessionsRevokedAt === null) return { revokedAt: null };
    const revokedAt = Date.parse(state.sessionsRevokedAt);
    return Number.isNaN(revokedAt) ? null : { revokedAt };
  };
}
