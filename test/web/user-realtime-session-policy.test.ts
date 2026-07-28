import { describe, expect, it, vi } from 'vitest';

import { terminateDeletedUserSession } from '../../web/src/hooks/user-realtime-session-policy.js';

describe('deleted-user realtime session policy', () => {
  it('stops realtime and cached work before logging out and redirecting', async () => {
    const order: string[] = [];

    await terminateDeletedUserSession({
      closeRealtime: () => order.push('close-realtime'),
      clearPendingInvalidations: () => order.push('clear-pending'),
      cancelQueries: async () => {
        order.push('cancel-queries');
      },
      clearQueryCache: () => order.push('clear-query-cache'),
      signOut: async () => {
        order.push('sign-out');
      },
      redirectToSignIn: () => order.push('redirect'),
    });

    expect(order).toEqual([
      'close-realtime',
      'clear-pending',
      'cancel-queries',
      'clear-query-cache',
      'sign-out',
      'redirect',
    ]);
  });

  it('still redirects when server-side session cleanup fails', async () => {
    const redirectToSignIn = vi.fn();

    await expect(
      terminateDeletedUserSession({
        closeRealtime: vi.fn(),
        clearPendingInvalidations: vi.fn(),
        cancelQueries: vi.fn(async () => undefined),
        clearQueryCache: vi.fn(),
        signOut: vi.fn(async () => {
          throw new Error('Redis unavailable');
        }),
        redirectToSignIn,
      }),
    ).resolves.toBeUndefined();

    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it('still clears cached state and redirects when query cancellation fails', async () => {
    const clearQueryCache = vi.fn();
    const signOut = vi.fn(async () => undefined);
    const redirectToSignIn = vi.fn();

    await expect(
      terminateDeletedUserSession({
        closeRealtime: vi.fn(),
        clearPendingInvalidations: vi.fn(),
        cancelQueries: vi.fn(async () => {
          throw new Error('transport cancellation failed');
        }),
        clearQueryCache,
        signOut,
        redirectToSignIn,
      }),
    ).resolves.toBeUndefined();

    expect(clearQueryCache).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(redirectToSignIn).toHaveBeenCalledTimes(1);
  });
});
