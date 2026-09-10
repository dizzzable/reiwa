/**
 * In-cabinet hints — the customer-facing half.
 *
 * Three calls, and all three take the identity from the caller rather than
 * from anything the browser said about itself: what should this person see,
 * it is on screen, and here is how it ended.
 *
 * ── Why the audience travels with the question ────────────────────────────
 *
 * Some hints are actively wrong in the wrong place — "install the app" shown
 * to somebody already running the installed app, "open our bot" to somebody
 * already inside Telegram. The cabinet is the only side that knows which of
 * the three surfaces it is on, so it says so when it asks, and the panel filters
 * before answering. Sending a hint and letting the client decide whether to
 * draw it would burn the delivery either way.
 */
import type { AdminTransport } from '../transport.js';

/** One hint, already resolved for the viewer's locale. */
export interface CabinetHint {
  readonly deliveryId: string;
  readonly key: string;
  readonly mode: string;
  readonly tone: string;
  readonly title: string;
  readonly body: string;
  readonly ctaKind: string;
  readonly ctaLabel: string | null;
  readonly ctaTarget: string | null;
}

export interface HintAudienceInput {
  readonly userId?: string | null;
  readonly telegramId?: string | null;
  readonly surface?: 'tma' | 'pwa' | 'browser';
  readonly formFactor?: 'mobile' | 'tablet' | 'desktop';
  readonly locale?: 'ru' | 'en';
}

/**
 * The header this cabinet declares its drawable modes in.
 *
 * NOT a body field. The panel validates bodies with `forbidNonWhitelisted`, so
 * a panel that has not learned the field answers 400 rather than ignoring it —
 * and a 400 here is not a lost mode, it is a cabinet with no hints at all.
 * An unknown header is simply not read, in either direction.
 */
export const HINT_MODES_HEADER = 'x-reiwa-hint-modes';

export class UserHintsNamespace {
  public constructor(private readonly transport: AdminTransport) {}

  /**
   * The next hint this person should see, or `{ hint: null }`.
   *
   * `null` is the overwhelmingly common answer, which is why this is worth
   * calling on every cabinet entry: one indexed read, and the panel does the
   * audience filtering rather than shipping hints the client would discard.
   */
  next(
    input: HintAudienceInput,
    /** What this build can draw. Omitted means the panel assumes MODAL only. */
    drawableModes?: readonly string[],
  ): Promise<{ hint: CabinetHint | null }> {
    return this.transport.request<{ hint: CabinetHint | null }>(
      'POST',
      '/api/internal/user-hints/next',
      input,
      drawableModes === undefined || drawableModes.length === 0
        ? undefined
        : { [HINT_MODES_HEADER]: drawableModes.join(',') },
    );
  }

  /**
   * Something the cabinet saw for itself.
   *
   * The moment a freshly bought subscription's profile becomes usable exists
   * only in the browser — it is the end of a poll, not a server event — so the
   * client reports it and the queue decides whether anything is owed.
   */
  moment(
    input: HintAudienceInput & { moment: 'subscription-ready' },
  ): Promise<{ raised: boolean }> {
    return this.transport.request<{ raised: boolean }>(
      'POST',
      '/api/internal/user-hints/moment',
      input,
    );
  }

  /** Stamped when it reaches the screen, not when it was fetched. */
  markShown(input: HintAudienceInput & { deliveryId: string }): Promise<{ ok: boolean }> {
    return this.transport.request<{ ok: boolean }>(
      'POST',
      '/api/internal/user-hints/shown',
      input,
    );
  }

  /**
   * How it ended.
   *
   * `acted` and `dismissed` are separate because collapsing them makes "this
   * hint helps" indistinguishable from "people close it to be rid of it".
   */
  close(
    input: HintAudienceInput & { deliveryId: string; outcome: 'acted' | 'dismissed' },
  ): Promise<{ ok: boolean }> {
    return this.transport.request<{ ok: boolean }>(
      'POST',
      '/api/internal/user-hints/closed',
      input,
    );
  }
}
