/**
 * Spec for the route-level upstream-error classifier.
 *
 * Asserts the two behaviours route handlers rely on:
 *   - typed `UpstreamError` is classified by its exact `status`
 *   - plain `Error`s (legacy callers / test fakes that embed the code in
 *     the message) fall back to a message-text scan so existing routes
 *     keep working
 */
import { describe, expect, it } from 'vitest';

import {
  describeUpstreamError,
  isUpstreamStatus,
} from '../../../src/api/lib/upstream-error.js';
import { UpstreamError } from '../../../src/core/errors/index.js';

describe('describeUpstreamError', () => {
  it('extracts status + body from a typed UpstreamError', () => {
    const err = new UpstreamError('POST', '/x', 409, 'already exists');
    expect(describeUpstreamError(err)).toEqual({
      status: 409,
      message: 'already exists',
    });
  });

  it('returns null status + raw message for a plain Error', () => {
    const err = new Error('AdminClient: POST /x → 409: already exists');
    expect(describeUpstreamError(err)).toEqual({
      status: null,
      message: 'AdminClient: POST /x → 409: already exists',
    });
  });

  it('stringifies non-Error throwables', () => {
    expect(describeUpstreamError('boom')).toEqual({ status: null, message: 'boom' });
    expect(describeUpstreamError(undefined)).toEqual({ status: null, message: '' });
  });
});

describe('isUpstreamStatus', () => {
  it('matches a typed UpstreamError by exact status only', () => {
    const err = new UpstreamError('POST', '/x', 409, '503 appears in the body text');
    expect(isUpstreamStatus(err, 409)).toBe(true);
    // body text must NOT leak into status matching for typed errors
    expect(isUpstreamStatus(err, 503)).toBe(false);
  });

  it('falls back to message scan for plain Errors (back-compat)', () => {
    const err = new Error('AdminClient: POST /x → 409: already exists');
    expect(isUpstreamStatus(err, 409)).toBe(true);
    expect(isUpstreamStatus(err, 500)).toBe(false);
  });
});
