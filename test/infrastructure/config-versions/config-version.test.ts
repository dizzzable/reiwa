import { describe, expect, it } from 'vitest';

import {
  CONFIG_VERSION_KEYS,
  canonicalJson,
  configVersionOf,
  legalDocumentsVersionKey,
} from '../../../src/infrastructure/config-versions/config-version.js';

/**
 * The version of a settings group, as the cabinet computes it from the copy it
 * holds and the panel computes it from what its route serves.
 *
 * The two implementations live in two repositories that share no package, so
 * the strongest link available is the same vector pinned on both sides:
 * `rezeis-admin/test/config-version-hash.spec.ts` asserts the very same string.
 * If either side changes the function, its own vector goes red — before the
 * two can disagree in production, where a disagreement would read as "every
 * group changed" on every poll.
 */
const VECTOR = { b: [1, 'two', { d: null, c: true }], a: 'x', n: 1.5, u: 'я' };
const VECTOR_VERSION = '3cae81b052f3c76ccc55eed3869b39d9';

describe('configVersionOf', () => {
  it('matches the vector the panel pins', () => {
    expect(configVersionOf(VECTOR)).toBe(VECTOR_VERSION);
  });

  it('writes objects with sorted keys and arrays in their order', () => {
    expect(canonicalJson(VECTOR)).toBe('{"a":"x","b":[1,"two",{"c":true,"d":null}],"n":1.5,"u":"я"}');
  });

  it('does not see the order a service built an object in', () => {
    expect(configVersionOf({ a: 1, b: { y: 2, x: 3 } })).toBe(configVersionOf({ b: { x: 3, y: 2 }, a: 1 }));
  });

  it('sees the order of an array: it is what the operator configured', () => {
    expect(configVersionOf({ buttons: ['a', 'b'] })).not.toBe(configVersionOf({ buttons: ['b', 'a'] }));
  });

  it('versions what the wire carries: a Date as its ISO string, an undefined field as absent', () => {
    // The panel hashes its objects, the cabinet what it parsed off the wire.
    const at = new Date('2026-09-24T12:00:00.000Z');
    expect(configVersionOf({ at, gone: undefined, kept: 1 })).toBe(
      configVersionOf({ at: '2026-09-24T12:00:00.000Z', kept: 1 }),
    );
  });

  it('tells a change of one value apart', () => {
    expect(configVersionOf({ accessMode: 'PUBLIC' })).not.toBe(configVersionOf({ accessMode: 'RESTRICTED' }));
  });

  it('gives 32 hex digits, and a version for null too', () => {
    expect(configVersionOf(VECTOR)).toMatch(/^[0-9a-f]{32}$/);
    expect(configVersionOf(null)).toMatch(/^[0-9a-f]{32}$/);
    expect(configVersionOf(undefined)).toBe(configVersionOf(null));
  });
});

describe('the version keys', () => {
  it('name the nine groups the panel versions', () => {
    expect(Object.values(CONFIG_VERSION_KEYS).sort()).toEqual([
      'botConfig',
      'connectPage',
      'customEmojiPacks',
      'guestSupport',
      'landing',
      'legalDocuments.en',
      'legalDocuments.ru',
      'platformPolicy',
      'publicConfig',
    ]);
  });

  it('map a locale to its legal-documents key by the panel’s rule: en, else the primary language', () => {
    expect(legalDocumentsVersionKey('en')).toBe('legalDocuments.en');
    expect(legalDocumentsVersionKey(' EN ')).toBe('legalDocuments.en');
    expect(legalDocumentsVersionKey('ru')).toBe('legalDocuments.ru');
    expect(legalDocumentsVersionKey('uk')).toBe('legalDocuments.ru');
  });
});
