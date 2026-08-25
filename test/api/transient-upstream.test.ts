import { describe, expect, it } from 'vitest';

import {
  TRANSIENT_REPORT_WINDOW_MS,
  TransientReportThrottle,
  transientUpstreamCode,
} from '../../src/api/transient-upstream.js';

/**
 * A BLIP AND A BUG MUST NOT LOOK THE SAME.
 *
 * Production, 2026-08-25: `getaddrinfo EAI_AGAIN rezeispanel.2get.pro` on
 * `/api/v1/activity/notifications` — answered with `500 Internal server error`
 * and one operator alert per failed request.
 *
 * `EAI_AGAIN` is the resolver saying "temporary failure, ask again". Nothing
 * in the cabinet is broken, nothing the operator does fixes it, and it heals
 * by itself — so both halves of the old handling were wrong, and wrong in
 * opposite directions: the subscriber was told WE broke, and the operator was
 * told hundreds of times about one thirty-second blip.
 *
 * The correction is not silence. A blip and a real outage raise the SAME
 * error, so the first sighting always reports and only the repeats go quiet.
 * Every spec below exists to hold one of those two edges: the classification
 * must not be so wide that it hides bugs, and the throttle must not be so
 * quiet that it hides outages.
 */
describe('transient upstream failures are recognised without swallowing real ones', () => {
  it('recognises the code that started this', () => {
    const err = Object.assign(new Error('getaddrinfo EAI_AGAIN rezeispanel.2get.pro'), {
      code: 'EAI_AGAIN',
    });

    expect(transientUpstreamCode(err)).toBe('EAI_AGAIN');
  });

  it('recognises the same conditions in undici vocabulary', () => {
    // The transport speaks its own dialect for the identical situation, and a
    // list that only knew the libc spelling would page the operator per
    // request for exactly the failures it was written to calm.
    const err = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });

    expect(transientUpstreamCode(err)).toBe('UND_ERR_CONNECT_TIMEOUT');
  });

  it('reads one level of cause, because a DNS failure arrives wrapped', () => {
    const wrapped = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo EAI_AGAIN panel.example'), { code: 'EAI_AGAIN' }),
    });

    expect(transientUpstreamCode(wrapped)).toBe('EAI_AGAIN');
  });

  it('leaves an ordinary bug alone', () => {
    // ANTI-VACUITY, and the edge that matters most. "Everything is transient"
    // would pass every spec above while turning genuine 500s into throttled
    // 503s — the failure mode would be invisible AND misreported.
    expect(transientUpstreamCode(new TypeError('x is not a function'))).toBeNull();
    expect(transientUpstreamCode(Object.assign(new Error('nope'), { code: 'EPERM' }))).toBeNull();
    expect(transientUpstreamCode(null)).toBeNull();
    expect(transientUpstreamCode('a string')).toBeNull();
  });

  it('does not walk an unbounded cause chain', () => {
    // A transient buried two levels under a real bug is a real bug: something
    // in between decided to keep going and then failed on its own terms.
    const deep = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('middle'), {
        cause: Object.assign(new Error('inner'), { code: 'EAI_AGAIN' }),
      }),
    });

    expect(transientUpstreamCode(deep)).toBeNull();
  });
});

describe('the throttle quietens repeats without ever hiding a start', () => {
  it('always reports the first sighting of a code', () => {
    const throttle = new TransientReportThrottle(1_000);

    expect(throttle.shouldReport('EAI_AGAIN', 0)).toBe(true);
  });

  it('stays quiet for the rest of the window', () => {
    const throttle = new TransientReportThrottle(1_000);
    throttle.shouldReport('EAI_AGAIN', 0);

    expect(throttle.shouldReport('EAI_AGAIN', 1)).toBe(false);
    expect(throttle.shouldReport('EAI_AGAIN', 999)).toBe(false);
  });

  it('speaks again once the window has passed, so an outage keeps saying so', () => {
    // The difference between throttling and suppressing. A panel unreachable
    // for an hour must keep producing a line; only the flood is removed.
    const throttle = new TransientReportThrottle(1_000);
    throttle.shouldReport('EAI_AGAIN', 0);

    expect(throttle.shouldReport('EAI_AGAIN', 1_000)).toBe(true);
  });

  it('throttles per code, so a second failure is not hidden by the first', () => {
    const throttle = new TransientReportThrottle(1_000);
    throttle.shouldReport('EAI_AGAIN', 0);

    expect(throttle.shouldReport('ECONNREFUSED', 1)).toBe(true);
  });

  it('uses a window long enough to calm a flood and short enough to notice', () => {
    expect(TRANSIENT_REPORT_WINDOW_MS).toBeGreaterThanOrEqual(60_000);
    expect(TRANSIENT_REPORT_WINDOW_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
