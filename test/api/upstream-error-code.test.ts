import { describe, expect, it } from 'vitest';

import { UpstreamError } from '../../src/core/errors/index.js';
import { readUpstreamCode } from '../../src/api/lib/upstream-error.js';

/**
 * Reading the panel's reason code out of a failed upstream call.
 *
 * Why this is worth pinning: the registration route collapses a whole status
 * class into one sentence. The panel refuses at 403 for several unrelated
 * causes — the platform access mode, a missing invite, missing consent to a
 * legal document — and without the code every one of them reached the visitor
 * as "registration is disabled". That sentence is a lie whenever registration
 * is in fact enabled, and it tells the visitor nothing they can act on.
 *
 * The failure mode this guards is silent: drop the extraction and the route
 * still answers 403 with prose, still passes every route test, and simply
 * stops distinguishing "tick the boxes" from "come back later".
 */
function forbidden(body: string): UpstreamError {
  return new UpstreamError('POST', '/api/internal/web-auth/register', 403, body);
}

describe('readUpstreamCode', () => {
  it('reads a code the panel put at the top level', () => {
    expect(
      readUpstreamCode(
        forbidden(JSON.stringify({ code: 'LEGAL_CONSENT_REQUIRED', documents: ['OFFER'] })),
      ),
    ).toBe('LEGAL_CONSENT_REQUIRED');
  });

  it('reads a code nested under `message`', () => {
    // Nest serialises `new ForbiddenException({ code })` at the top level, but
    // some handlers hand it the object as the message instead. Both shapes
    // reach this helper from the same endpoint.
    expect(
      readUpstreamCode(forbidden(JSON.stringify({ message: { code: 'INVITE_REQUIRED' } }))),
    ).toBe('INVITE_REQUIRED');
  });

  it('returns null for a body that carries no code', () => {
    expect(readUpstreamCode(forbidden(JSON.stringify({ message: 'Forbidden' })))).toBeNull();
  });

  it('returns null rather than throwing on a body that is not JSON', () => {
    // An upstream proxy can answer 403 with an HTML error page. Throwing here
    // would turn a handled refusal into a 500.
    expect(readUpstreamCode(forbidden('<html>403 Forbidden</html>'))).toBeNull();
  });

  it('returns null for an empty code', () => {
    expect(readUpstreamCode(forbidden(JSON.stringify({ code: '' })))).toBeNull();
  });

  it('returns null for a plain Error, which carries no upstream body at all', () => {
    expect(readUpstreamCode(new Error('network down'))).toBeNull();
  });

  it('returns null for a JSON body that is not an object', () => {
    expect(readUpstreamCode(forbidden('"just a string"'))).toBeNull();
  });
});
