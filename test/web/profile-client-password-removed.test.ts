// @vitest-environment jsdom

/**
 * The SPA's `changePassword` (`PATCH /me/password`) is gone with the route: it
 * sent a password hash with no proof, nothing called it, and the route behind
 * it no longer exists (`test/api/me-password-route-removed.test.ts`). A
 * password changes through `changePasswordAuth` (`/auth/change-password`).
 */
import { describe, expect, it } from 'vitest';

describe('the web API client', () => {
  it('offers no password change beside /auth/change-password', async () => {
    const profile = await import('@/lib/api-client/profile');
    const client = await import('@/lib/api-client');

    expect(Object.keys(profile)).not.toContain('changePassword');
    expect(Object.keys(client)).not.toContain('changePassword');
    expect(Object.keys(client)).toContain('changePasswordAuth');
  });
});
