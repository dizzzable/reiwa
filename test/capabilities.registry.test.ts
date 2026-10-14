import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CABINET_CAPABILITIES,
  CAPABILITIES_HEADER_MAX_LENGTH,
  CAPABILITIES_HEADER_MAX_NAMES,
  CAPABILITY_ID_MAX_LENGTH,
  CAPABILITY_ID_PATTERN,
  declaredCapabilities,
  type ReiwaSurface,
} from '../src/core/capabilities.js';
import { stripComments } from './support/source-scan.js';

/**
 * THE CAPABILITIES THIS CABINET DECLARES TO THE PANEL (`src/core/capabilities.ts`).
 *
 * The panel holds an offer back from a cabinet that does not declare the id it
 * is gated on — today «Докупка трафика до сброса», on `web.addon-reset-end`. So
 * the declaration is load-bearing in both directions:
 *
 *   TOO NARROW — an id this cabinet implements is missing, or the wrong process
 *   sends it. The panel then treats an up-to-date cabinet as an old one:
 *   the top-up is not sold, and the operator gets «🧩 Кабинет старше панели».
 *
 *   TOO WIDE — an id is declared that nothing implements. The panel sells what
 *   the cabinet cannot show.
 *
 * The panel's registry lives in the other repository, and no test here can see
 * it. The literal below is this side of the contract (pair design D1 §6.2);
 * the pair's end-to-end run compares the two sides.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The ids and releases agreed with the panel. A change here is a change there. */
const CONTRACT: ReadonlyArray<readonly [id: string, since: string]> = [
  ['web.addon-reset-end', '0.9.7.53'],
  ['web.lifetime-subscription', '0.9.7.53'],
  ['web.bell-addon-not-applied', '0.9.7.53'],
  ['web.panel-timezone-dates', '0.9.7.53'],
  // «Отсрочка первого списания по СБП»: the one id that is not since 0.9.7.53. The panel's
  // registry has it with the same release (`web.autopay-first-charge-delay`, since
  // 0.9.7.56), and the pair's end-to-end run compares the two.
  ['web.autopay-first-charge-delay', '0.9.7.56'],
  ['api.appearance-report', '0.9.7.53'],
  ['api.config-version-poll', '0.9.7.53'],
  ['bot.config-version-poll', '0.9.7.53'],
  ['bot.stale-button-menu', '0.9.7.53'],
];

const SURFACES: readonly ReiwaSurface[] = ['api', 'bot', 'worker'];

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number(part));
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe('the registry is the contract with the panel', () => {
  it('declares exactly the agreed ids, each since the agreed release', () => {
    expect(CABINET_CAPABILITIES.map((capability) => [capability.id, capability.since])).toEqual(CONTRACT);
  });

  it('writes every id in the shared format: an area this cabinet has, at most 48 characters, once', () => {
    const ids = CABINET_CAPABILITIES.map((capability) => capability.id);
    for (const id of ids) {
      expect(id, id).toMatch(CAPABILITY_ID_PATTERN);
      expect(id.length, id).toBeLessThanOrEqual(CAPABILITY_ID_MAX_LENGTH);
      // `panel.*` is the panel's own area: it declares those, never this cabinet.
      expect(id, id).toMatch(/^(web|api|bot)\./);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a module that exists for every id: web.* in the web app, api.* and bot.* on the server', () => {
    for (const capability of CABINET_CAPABILITIES) {
      const path = capability.implementedBy;
      expect(existsSync(join(ROOT, path)), `${capability.id} → ${path}`).toBe(true);
      const area = capability.id.slice(0, capability.id.indexOf('.'));
      expect(path.startsWith(area === 'web' ? 'web/src/' : 'src/'), `${capability.id} → ${path}`).toBe(true);
    }
  });

  it('dates every id to a release no newer than this one, or to the very next while it is not out yet', () => {
    const current = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    // The release after this one: an id that arrives in the work the next release
    // will carry is dated to it, and the release commit that raises package.json
    // makes the first clause hold. Anything further out is a typo, not a plan.
    const next = versionParts(current);
    next[next.length - 1] = (next[next.length - 1] ?? 0) + 1;
    for (const capability of CABINET_CAPABILITIES) {
      expect(capability.since, capability.id).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const released = compareVersions(capability.since, current) <= 0;
      const upcoming = compareVersions(capability.since, next.join('.')) === 0;
      expect(released || upcoming, `${capability.id} since ${capability.since}, this release is ${current}`).toBe(true);
    }
  });
});

describe('which process declares what', () => {
  // Worked out from the id prefixes here, not from the mapping in the module:
  // a spec that reused the mapping would agree with any mistake in it.
  const byPrefix = (...prefixes: string[]): string[] =>
    CABINET_CAPABILITIES.map((capability) => capability.id).filter((id) =>
      prefixes.some((prefix) => id.startsWith(`${prefix}.`)),
    );

  it('reiwa-api declares web.* and api.*: it serves the web app', () => {
    expect(declaredCapabilities('api')).toEqual(byPrefix('web', 'api'));
    expect(declaredCapabilities('api')).toContain('web.addon-reset-end');
  });

  it('reiwa-bot declares bot.* only', () => {
    expect(declaredCapabilities('bot')).toEqual(byPrefix('bot'));
    expect(declaredCapabilities('bot')).not.toContain('web.addon-reset-end');
  });

  it('the worker declares nothing', () => {
    expect(declaredCapabilities('worker')).toEqual([]);
  });

  it('every id is declared by exactly one process', () => {
    const declared = SURFACES.flatMap((surface) => declaredCapabilities(surface));
    expect([...declared].sort()).toEqual(CABINET_CAPABILITIES.map((capability) => capability.id).sort());
  });

  it('fits what the panel reads of the header: 2048 characters and 64 names', () => {
    // Past either bound the panel drops the rest without a sound, and a
    // capability this cabinet has would read as one it lacks.
    for (const surface of SURFACES) {
      const ids = declaredCapabilities(surface);
      expect(ids.length, surface).toBeLessThanOrEqual(CAPABILITIES_HEADER_MAX_NAMES);
      expect(ids.join(',').length, surface).toBeLessThanOrEqual(CAPABILITIES_HEADER_MAX_LENGTH);
    }
  });
});

describe('the transport is the only author of the two headers', () => {
  // A caller that spelled `X-Reiwa-Capabilities` itself would put a second
  // line on the wire, which the panel reads joined with ours. The transport
  // folds such a spelling into its own at run time; this keeps anyone from
  // writing one in the first place. Comments do not count.
  const OWNER = 'src/core/capabilities.ts';

  /** Every `.ts` and `.tsx` file under `dir`, as a path from the repository root with `/`. */
  function codeFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${entry}`;
      if (statSync(join(ROOT, path)).isDirectory()) codeFiles(path, found);
      else if (/\.tsx?$/.test(entry)) found.push(path);
    }
    return found;
  }

  const scanned = [...codeFiles('src'), ...codeFiles('web/src')];

  it('finds the files it scans, and the names where they are defined', () => {
    expect(scanned.length).toBeGreaterThan(300);
    expect(scanned).toContain(OWNER);
    const owner = stripComments(readFileSync(join(ROOT, OWNER), 'utf8'));
    expect(owner).toContain("'x-reiwa-client'");
    expect(owner).toContain("'x-reiwa-capabilities'");
  });

  it('spells neither name anywhere else in src/ or web/src/', () => {
    const offenders = scanned
      .filter((path) => path !== OWNER)
      .filter((path) => /x-reiwa-(client|capabilities)/i.test(stripComments(readFileSync(join(ROOT, path), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
