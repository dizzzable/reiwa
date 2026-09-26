/**
 * The identity headers are valid whatever the machine and the build are called.
 *
 * `x-reiwa-client` carries the running version (`REIWA_VERSION`, which an
 * operator can set), the commit and the container's hostname. undici refuses a
 * request whose header value holds a control character or a character outside
 * ASCII, and it refuses the WHOLE call (`UND_ERR_INVALID_ARG`). So a single bad
 * value would cut the cabinet off from the panel on every call, not only this
 * header. The panel, for its part, reads four `key=value` pairs split on `; `.
 *
 * Properties, for ANY strings in the three free values and ANY list of ids:
 *   1. the client header is printable ASCII, at most 256 characters, and reads
 *      as exactly the four keys, each with a value of safe characters;
 *   2. the capabilities header holds only ids in the shared format, and keeps
 *      every such id it was given, in order;
 *   3. values that are already safe come out unchanged;
 *   4. formatting is stable: the header of a formatted identity formats to
 *      itself.
 *
 * On node:test like the other property suites (`npm run test:pbt`). That
 * script quotes its glob, so node expands it and `**` reaches subdirectories.
 * Left unquoted, `sh` on CI expanded `**` as ONE directory level: a property
 * file in a subdirectory made it pass only that file and drop the rest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  CLIENT_HEADER_MAX_LENGTH,
  REIWA_CAPABILITIES_HEADER,
  REIWA_CLIENT_HEADER,
  formatIdentityHeaders,
  isCapabilityId,
  type ReiwaClientIdentity,
  type ReiwaSurface,
} from '../src/core/capabilities.js';

const surface = fc.constantFrom<ReiwaSurface>('api', 'bot', 'worker');
/** Anything a string can hold: controls, separators, astral characters, lone surrogates. */
const anyText = fc.string({ unit: 'binary', maxLength: 300 });
const validId = fc.stringMatching(/^(web|api|bot|panel)\.[a-z0-9]{1,8}(-[a-z0-9]{1,8}){0,3}$/);
const anyIds = fc.array(fc.oneof(validId, anyText), { maxLength: 20 });

const PAIR = /^(surface|version|commit|instance)=([\w.+-]+)$/;

function parseClient(header: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const pair of header.split('; ')) {
    const match = PAIR.exec(pair);
    assert.ok(match, `a pair the panel cannot read: ${JSON.stringify(pair)}`);
    pairs.set(match[1]!, match[2]!);
  }
  return pairs;
}

describe('the identity headers, for any build and any machine', () => {
  it('1. the client header is printable ASCII, within 256 characters, four readable keys', () => {
    fc.assert(
      fc.property(surface, anyText, anyText, anyText, (s, version, commit, instance) => {
        const headers = formatIdentityHeaders({ surface: s, version, commit, instance, capabilities: [] });
        const client = headers[REIWA_CLIENT_HEADER]!;
        assert.ok(/^[\x20-\x7e]*$/.test(client), `not printable ASCII: ${JSON.stringify(client)}`);
        assert.ok(client.length <= CLIENT_HEADER_MAX_LENGTH, `too long: ${client.length}`);
        const pairs = parseClient(client);
        assert.deepEqual([...pairs.keys()], ['surface', 'version', 'commit', 'instance']);
        assert.equal(pairs.get('surface'), s);
      }),
      { numRuns: 500 },
    );
  });

  it('2. the capabilities header holds only ids in the format, and every one it was given', () => {
    fc.assert(
      fc.property(surface, anyIds, (s, capabilities) => {
        const identity: ReiwaClientIdentity = { surface: s, version: '0.9.7.54', commit: 'unknown', instance: 'reiwa', capabilities };
        const header = formatIdentityHeaders(identity)[REIWA_CAPABILITIES_HEADER]!;
        const sent = header === '' ? [] : header.split(',');
        for (const id of sent) assert.ok(isCapabilityId(id), `not an id: ${JSON.stringify(id)}`);
        assert.deepEqual(sent, capabilities.filter(isCapabilityId));
        assert.ok(/^[\x20-\x7e]*$/.test(header));
      }),
      { numRuns: 500 },
    );
  });

  it('3. values that are already safe come out unchanged', () => {
    const safe = fc.stringMatching(/^[A-Za-z0-9][\w.+-]{0,62}$/);
    fc.assert(
      fc.property(surface, safe, safe, safe, (s, version, commit, instance) => {
        const client = formatIdentityHeaders({ surface: s, version, commit, instance, capabilities: [] })[REIWA_CLIENT_HEADER];
        assert.equal(client, `surface=${s}; version=${version}; commit=${commit}; instance=${instance}`);
      }),
      { numRuns: 300 },
    );
  });

  it('4. formatting a formatted identity changes nothing', () => {
    fc.assert(
      fc.property(surface, anyText, anyText, anyText, (s, version, commit, instance) => {
        const once = formatIdentityHeaders({ surface: s, version, commit, instance, capabilities: [] })[REIWA_CLIENT_HEADER]!;
        const pairs = parseClient(once);
        const twice = formatIdentityHeaders({
          surface: s,
          version: pairs.get('version')!,
          commit: pairs.get('commit')!,
          instance: pairs.get('instance')!,
          capabilities: [],
        })[REIWA_CLIENT_HEADER];
        assert.equal(twice, once);
      }),
      { numRuns: 300 },
    );
  });
});
