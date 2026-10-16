import { describe, expect, it } from 'vitest';

import {
  narrowSubscriptionConnection,
  UNKNOWN_CONNECTION,
} from '../src/api/lib/subscription-connection.js';

/**
 * `GET /api/v1/subscription/:id/connection` — what the browser is told about
 * one VPN profile while the guided connect walk waits for it.
 *
 * Narrowed field by field: a panel newer than this cabinet may add fields, and
 * none of them may reach the browser unnamed. And `unknown` must swallow every
 * answer this side cannot vouch for — the walk asks the customer on it,
 * whereas a half-read answer could tell them a connection happened.
 */
describe('narrowSubscriptionConnection', () => {
  it('passes a known answer through, normalised, and nothing else', () => {
    expect(
      narrowSubscriptionConnection({
        state: 'known',
        onlineAt: '2026-10-16T11:59:40Z',
        firstConnectedAt: null,
        checkedAt: '2026-10-16T12:00:00.000Z',
        hwid: 'secret-device-id',
      }),
    ).toEqual({
      state: 'known',
      onlineAt: '2026-10-16T11:59:40.000Z',
      firstConnectedAt: null,
      checkedAt: '2026-10-16T12:00:00.000Z',
    });
  });

  it('answers unknown for anything it cannot vouch for', () => {
    expect(narrowSubscriptionConnection(null)).toEqual(UNKNOWN_CONNECTION);
    expect(narrowSubscriptionConnection([])).toEqual(UNKNOWN_CONNECTION);
    expect(narrowSubscriptionConnection({ state: 'unknown', checkedAt: '2026-10-16T12:00:00Z' })).toEqual(
      UNKNOWN_CONNECTION,
    );
    // A known answer the walk cannot measure "just now" against.
    expect(narrowSubscriptionConnection({ state: 'known', onlineAt: null, firstConnectedAt: null })).toEqual(
      UNKNOWN_CONNECTION,
    );
    expect(
      narrowSubscriptionConnection({
        state: 'known',
        onlineAt: 'not a date',
        firstConnectedAt: null,
        checkedAt: '2026-10-16T12:00:00Z',
      }),
    ).toEqual(UNKNOWN_CONNECTION);
    expect(
      narrowSubscriptionConnection({
        state: 'known',
        onlineAt: 1760616000000,
        firstConnectedAt: null,
        checkedAt: '2026-10-16T12:00:00Z',
      }),
    ).toEqual(UNKNOWN_CONNECTION);
  });
});
