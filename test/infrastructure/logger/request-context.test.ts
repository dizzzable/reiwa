/**
 * AsyncLocalStorage request-context specs.
 *
 * These pin the leak invariants Wave 4B's tracing relies on:
 *   - reads outside any scope return `undefined`
 *   - reads inside a scope return that scope's id
 *   - sibling scopes do not see each other's id, even when their
 *     async work interleaves (the ALS guarantees this; the test exists
 *     so a future refactor that swaps ALS for a module-level mutable
 *     gets caught immediately)
 */
import { describe, expect, it } from 'vitest';

import {
  getCurrentRequestId,
  getRequestContext,
  runWithRequestContext,
} from '../../../src/infrastructure/logger/request-context.js';

describe('runWithRequestContext', () => {
  it('returns undefined outside any scope', () => {
    expect(getCurrentRequestId()).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });

  it('exposes the seeded id synchronously inside the scope', () => {
    runWithRequestContext({ requestId: 'sync-id' }, () => {
      expect(getCurrentRequestId()).toBe('sync-id');
      expect(getRequestContext()?.requestId).toBe('sync-id');
    });
  });

  it('propagates the id across awaits', async () => {
    await runWithRequestContext({ requestId: 'await-id' }, async () => {
      expect(getCurrentRequestId()).toBe('await-id');
      await Promise.resolve();
      expect(getCurrentRequestId()).toBe('await-id');
      await new Promise((r) => setImmediate(r));
      expect(getCurrentRequestId()).toBe('await-id');
    });
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it('isolates concurrent scopes from each other', async () => {
    const a = runWithRequestContext({ requestId: 'A' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getCurrentRequestId();
    });
    const b = runWithRequestContext({ requestId: 'B' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCurrentRequestId();
    });
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult).toBe('A');
    expect(bResult).toBe('B');
  });

  it('forwards the scoped fn return value', () => {
    const out = runWithRequestContext({ requestId: 'r' }, () => 'payload');
    expect(out).toBe('payload');
  });
});
