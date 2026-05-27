/**
 * System namespace — health probe + global settings (platform policy,
 * registration toggle) and the worker pull endpoint that doesn't fit
 * any user-scoped namespace.
 */
import type { AdminTransport } from '../transport.js';

export class SystemNamespace {
  constructor(private readonly transport: AdminTransport) {}

  test(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/test');
  }

  getPlatformPolicy(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/settings/platform-policy');
  }

  getRegistrationToggle(): Promise<{ enabled: boolean }> {
    return this.transport.request<{ enabled: boolean }>(
      'GET',
      '/api/internal/settings/registration-toggle',
    );
  }

  getExpiryAlerts(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/worker/expiry-alerts');
  }
}
