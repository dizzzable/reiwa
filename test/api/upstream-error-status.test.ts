/**
 * Reading an upstream failure: a status is a NUMBER, and a missing route is
 * the panel's own answer — never a guess from text.
 *
 *   - `isUpstreamStatus` still falls back to a plain error's text (legacy
 *     callers and fakes rely on it), but only for the status as a number of its
 *     own: "404" inside "10.0.0.5:4040" is a port;
 *   - `isUpstreamMissingRoute` is true only for a typed 404 whose body is the
 *     panel's refusal of a route it does not have — its error filter's envelope
 *     (the router's message scrubbed to "Request failed") or plain Nest's
 *     "Cannot POST …" — for the path that was asked. A proxy's page while the
 *     panel restarts, a route that exists and found no record, a product
 *     refusal, or the envelope of some other path is not that.
 */
import { describe, expect, it } from 'vitest';

import { isUpstreamMissingRoute, isUpstreamStatus } from '../../src/api/lib/upstream-error.js';
import { UpstreamError } from '../../src/core/errors/index.js';

const PATH = '/api/internal/web-auth/sessions/state';

function panel404(body: unknown, path = PATH): UpstreamError {
  return new UpstreamError('POST', path, 404, typeof body === 'string' ? body : JSON.stringify(body));
}

const ENVELOPE = {
  timestamp: '2026-09-19T00:00:00.000Z',
  path: PATH,
  requestId: null,
  statusCode: 404,
  message: 'Request failed',
  errorCode: 'NOT_FOUND',
  error: 'Not Found',
};

describe('isUpstreamStatus', () => {
  it('reads a status in a plain error’s text only as a number of its own', () => {
    expect(isUpstreamStatus(new Error('Request failed with status code 404'), 404)).toBe(true);
    expect(isUpstreamStatus(new Error('404 Not Found'), 404)).toBe(true);
    expect(isUpstreamStatus(new Error('connect ECONNREFUSED 10.0.0.5:4040'), 404), 'a port read as a status').toBe(false);
    expect(isUpstreamStatus(new Error('upstream 14049 bytes'), 404)).toBe(false);
  });

  it('prefers the typed status', () => {
    expect(isUpstreamStatus(new UpstreamError('POST', PATH, 404, 'body with 409 in it'), 409)).toBe(false);
    expect(isUpstreamStatus(new UpstreamError('POST', PATH, 409, ''), 409)).toBe(true);
  });
});

describe('isUpstreamMissingRoute', () => {
  it('is the panel’s filtered answer for a route it does not have', () => {
    expect(isUpstreamMissingRoute(panel404(ENVELOPE))).toBe(true);
  });

  it('is plain Nest’s answer for a route it does not have', () => {
    expect(
      isUpstreamMissingRoute(panel404({ statusCode: 404, message: `Cannot POST ${PATH}`, error: 'Not Found' })),
    ).toBe(true);
  });

  it('is not a proxy’s page, nor a body that is not JSON', () => {
    expect(isUpstreamMissingRoute(panel404('<html><body><h1>404 Not Found</h1></body></html>'))).toBe(false);
    expect(isUpstreamMissingRoute(panel404('Not Found'))).toBe(false);
  });

  it('is not a route that exists and found no record, nor a product refusal', () => {
    expect(isUpstreamMissingRoute(panel404({ statusCode: 404, message: 'Web account not found', error: 'Not Found' }))).toBe(false);
    expect(isUpstreamMissingRoute(panel404({ ...ENVELOPE, code: 'SOMETHING_NOT_FOUND' }))).toBe(false);
  });

  it('is not the envelope of another path', () => {
    expect(isUpstreamMissingRoute(panel404({ ...ENVELOPE, path: '/api/internal/web-auth/other' }))).toBe(false);
    expect(
      isUpstreamMissingRoute(panel404({ statusCode: 404, message: 'Cannot POST /api/internal/other', error: 'Not Found' })),
    ).toBe(false);
  });

  it('is never read from text: a plain error, or any other status', () => {
    expect(isUpstreamMissingRoute(new Error(`AdminClient: POST ${PATH} → 404: ${JSON.stringify(ENVELOPE)}`))).toBe(false);
    expect(isUpstreamMissingRoute(new UpstreamError('POST', PATH, 410, JSON.stringify(ENVELOPE)))).toBe(false);
  });
});
