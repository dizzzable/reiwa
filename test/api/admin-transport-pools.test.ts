import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_POOL_OPTIONS,
  ADMIN_STREAM_POOL_OPTIONS,
} from '../../src/infrastructure/admin-client/transport.js';
import { sourceFiles, stripComments } from '../support/source-scan.js';

/**
 * THE TRANSPORT TO THE PANEL IS A DECISION, NOT A DEFAULT.
 *
 * On 2026-08-24 production logged this, repeatedly:
 *
 *   HeadersTimeoutError: HTTP/2: "headers timeout after 10000"
 *     at ClientHttp2Stream.onTimeout (undici/lib/dispatcher/client-h2.js)
 *
 * followed, twenty-seven seconds later, by FOUR `/realtime/stream` feeds
 * completing in the same millisecond, each about 106 minutes old. One
 * connection went bad and took every in-flight API call and every live feed
 * with it.
 *
 * Nothing in this repository had asked for HTTP/2. undici enables it by
 * default (`// We validate only if allowH2 is enabled or null (enabled by
 * default)`), so the transport changed under a dependency upgrade — and with
 * it, silently, the meaning of `connections: 50`. That number was chosen for
 * fifty INDEPENDENT connections, one bad connection costing one request. Under
 * HTTP/2 it is decorative: everything multiplexes onto one TCP connection and
 * the unit of contention becomes the stream.
 *
 * The lesson is not "HTTP/2 is bad". It is that a default which rewrites the
 * failure model must not be able to change without someone editing a line.
 * These specs are that line's guard.
 */

describe('the admin transport pins its protocol instead of inheriting one', () => {
  it('disables HTTP/2 explicitly on the request pool', () => {
    // `false`, not `undefined`. Absent means "whatever undici decides this
    // major version", which is precisely how the incident arrived.
    expect(ADMIN_POOL_OPTIONS.allowH2).toBe(false);
  });

  it('disables HTTP/2 explicitly on the stream pool too', () => {
    // The feeds are the traffic that suffered most — hours of accumulated work
    // discarded in one millisecond — so this pool needs the guarantee at least
    // as much as the other one.
    expect(ADMIN_STREAM_POOL_OPTIONS.allowH2).toBe(false);
  });

  it('gives feeds their own connections, with the unbounded body only there', () => {
    // The two pools must differ in the way that MATTERS, not merely exist as
    // two objects. `bodyTimeout: 0` is what makes a stream a stream; handing it
    // to ordinary calls would mean a stalled API request waits forever, which
    // is the neighbouring bug this split exists to keep impossible.
    expect(ADMIN_STREAM_POOL_OPTIONS.bodyTimeout).toBe(0);
    expect(ADMIN_POOL_OPTIONS.bodyTimeout).toBeGreaterThan(0);
    expect(ADMIN_POOL_OPTIONS.headersTimeout).toBeGreaterThan(0);
    expect(ADMIN_STREAM_POOL_OPTIONS.headersTimeout).toBeGreaterThan(0);
  });

  it('sizes the feed pool for feeds, not for the API', () => {
    // Each open tab holds one connection here for as long as it stays open.
    // The number is a ceiling on concurrent live feeds; exceeding it degrades
    // the feed and leaves the API alone, which is the whole point.
    expect(ADMIN_STREAM_POOL_OPTIONS.connections).toBeGreaterThanOrEqual(
      ADMIN_POOL_OPTIONS.connections,
    );
  });

  it('leaves no pool anywhere in src/ taking the protocol default', () => {
    // Does not name the two known pools: the failure mode is a THIRD one,
    // added later, built the way both of these used to be.
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(/new Pool\(([\s\S]*?)\)/g)) {
        const args = match[1];
        // Either the options are spelled inline with `allowH2`, or they come
        // from one of the two exported constants that this file has already
        // pinned above.
        const pinned =
          args.includes('allowH2') ||
          args.includes('ADMIN_POOL_OPTIONS') ||
          args.includes('ADMIN_STREAM_POOL_OPTIONS');
        if (!pinned) offenders.push(`${file}: new Pool(${args.trim()})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the split is where the traffic is, not only in the options', () => {
  it('opens SSE on the stream pool and never on the request pool', () => {
    // The specs above pin the two option sets. None of them would notice
    // `openStream` quietly going back to `this.pool` — one identifier, and the
    // separation is undone while every assertion above stays green. That is
    // the shape of undoing this fix, so it gets its own guard.
    const source = stripComments(
      readFileSync('src/infrastructure/admin-client/transport.ts', 'utf8'),
    );
    const from = source.indexOf('async openStream(');
    expect(from).toBeGreaterThan(-1);
    const body = source.slice(from, source.indexOf('\n  }', from));

    expect(body).toContain('this.streamPool.request(');
    expect(body).not.toContain('this.pool.request(');
  });

  it('closes both pools, so a live feed cannot outlast a shutdown', () => {
    // A stream pool left open holds the process through SIGTERM for as long as
    // one subscriber keeps a tab open — and the tabs here live for hours.
    const source = stripComments(
      readFileSync('src/infrastructure/admin-client/transport.ts', 'utf8'),
    );
    const from = source.indexOf('async close(');
    expect(from).toBeGreaterThan(-1);
    const body = source.slice(from, source.indexOf('\n  }', from));

    expect(body).toContain('this.pool.close()');
    expect(body).toContain('this.streamPool.close()');
  });
});
