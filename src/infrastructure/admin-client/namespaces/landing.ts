/**
 * Landing namespace — the effective PUBLISHED web-landing config.
 *
 * rezeis-admin owns the landing builder; reiwa fetches the effective published
 * config here (or the `{ enabled: false }` sentinel when nothing is published /
 * the module is off) and serves it to unauthenticated web visitors before
 * sign-in. The payload is data-only (typed sections), safe to cache publicly.
 */
import type { AdminTransport } from '../transport.js';

export class LandingNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /**
   * Effective published landing config, or `{ enabled: false }` when the
   * module is disabled / unpublished. The shape is re-validated by the reiwa
   * web renderer (fail-closed), so it is returned untyped here.
   */
  getEffective(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/landing-config/effective');
  }
}
