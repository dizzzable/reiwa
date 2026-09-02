/**
 * Wheel namespace — the cabinet's view of the wheel of fortune, the spin
 * itself, buying spins with points, and the person's own history.
 *
 * User-scoped throughout: the `:userRef` the upstream controller resolves
 * comes from the reiwa session and never from the browser, so one person can
 * neither spin for nor read another.
 *
 * The odds are deliberately absent from every response. That is enforced
 * upstream, where the shape is defined; nothing here can ask for them.
 */
import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

function reference(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return identity.userId;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return identity.telegramId;
  }
  throw new Error('A userId or telegramId is required');
}

export class WheelNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /** The wheel as this person sees it: sectors, balances, the free spin. */
  view(identity: UserIdentity): Promise<unknown> {
    return this.transport.request(
      'GET',
      `/api/internal/wheel/${encodeURIComponent(reference(identity))}`,
    );
  }

  /**
   * Spin once.
   *
   * `idempotencyKey` is the browser's own handle for this spin and is passed
   * straight through: a double tap or a retry after a dropped response carries
   * the same value and is answered with the spin already taken, rather than
   * costing a second one.
   */
  spin(identity: UserIdentity, idempotencyKey: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/wheel/${encodeURIComponent(reference(identity))}/spin`,
      { idempotencyKey },
    );
  }

  /** Buy spins with points. */
  buy(identity: UserIdentity, count: number, idempotencyKey: string): Promise<unknown> {
    return this.transport.request(
      'POST',
      `/api/internal/wheel/${encodeURIComponent(reference(identity))}/buy`,
      { count, idempotencyKey },
    );
  }

  /** This person's own spins, newest first. */
  history(
    identity: UserIdentity,
    params: { cursor?: string | null; limit?: number } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams();
    if (typeof params.cursor === 'string' && params.cursor.length > 0) {
      query.set('cursor', params.cursor);
    }
    if (typeof params.limit === 'number') query.set('limit', String(params.limit));
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return this.transport.request(
      'GET',
      `/api/internal/wheel/${encodeURIComponent(reference(identity))}/history${suffix}`,
    );
  }
}
