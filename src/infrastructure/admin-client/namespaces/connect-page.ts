/**
 * Connect-page namespace — the catalog behind the cabinet's connect screen.
 *
 * rezeis-admin owns it: which apps exist per platform, how to install them, and
 * what each button does. The panel validates it on the way in (schema, icon
 * sanitizer, and an audit for catalogs that parse but cannot be used), so what
 * arrives here has already been checked by the only side that can show an
 * operator what is wrong with it.
 *
 * Returned untyped on purpose. The panel and the cabinet ship as separate
 * images, and a shared type here would be a promise the two versions cannot
 * keep across a rolling deploy — the cabinet re-reads the shape it needs and
 * degrades to "copy the link" for anything it does not recognise.
 */
import type { AdminTransport } from '../transport.js';

export class ConnectPageNamespace {
  constructor(private readonly transport: AdminTransport) {}

  /** The whole catalog. Small, identical for everybody, cached at the edge. */
  getEffective(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/connect-page/effective');
  }
}
