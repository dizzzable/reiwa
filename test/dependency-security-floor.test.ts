/**
 * Dependency security floor
 * ─────────────────────────
 * Reiwa's image was never scanned. The Security tab answered "no analysis
 * found" because `docker-publish.yml` had no Trivy step, so while the
 * identically-built rezeis image carried five open alerts, reiwa carried a
 * HIGH of its own — `ip-address` reached through `express-rate-limit` — with
 * nothing anywhere reporting it. The scan step now exists, but a scan only
 * speaks after an image is published; this file speaks before it is built.
 *
 * It asserts two things:
 *
 *   1. no lockfile in this repository resolves one of these packages below the
 *      version that fixed it, and
 *   2. the overrides that force a version stay expressed as ranges. An exact
 *      override is not a floor, it is a ceiling: `fast-uri: "3.1.4"` and
 *      `postcss: "8.5.18"` were both written to force an upgrade, and both
 *      ended up holding the tree at the version that later turned vulnerable.
 *
 * The floor is keyed by major, because a lockfile legitimately holds several
 * majors of one package at once — jsdom pulls undici 7 while the app uses
 * undici 8, and each line has its own fix. A major absent from the table is
 * not asserted: this guards the versions known to have been vulnerable, it
 * makes no claim about versions that did not exist when it was written.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type Floor = {
  readonly package: string;
  readonly major: number;
  readonly min: string;
  readonly advisory: string;
};

const FLOORS: readonly Floor[] = [
  {
    package: 'ip-address',
    major: 10,
    min: '10.3.1',
    advisory:
      'CVE-2026-69192 (also 69198, 54272) — leading-zero octets decoded as decimal while the resolver reads them as octal',
  },
  {
    package: 'undici',
    major: 8,
    min: '8.9.0',
    advisory:
      'GHSA-8xcm-r25x-g524 / GHSA-4cwx-7wf7-3272 — response desynchronization via the retry interceptor and cross-user disclosure via cache directives',
  },
  {
    package: 'undici',
    major: 7,
    min: '7.29.0',
    advisory: 'the same two defects on the 7.x line',
  },
  {
    package: 'postcss',
    major: 8,
    min: '8.5.23',
    advisory:
      'GHSA-fxqj-rqcc-2cmp — attacker-controlled sourceMappingURL reads arbitrary .map files when `from` is unset',
  },
  {
    package: 'fast-uri',
    major: 3,
    min: '3.1.5',
    advisory:
      'CVE-2026-18446 — a backslash authority introducer parses as path, so fast-uri and the WHATWG parser disagree about the host',
  },
  {
    package: 'brace-expansion',
    major: 5,
    min: '5.0.9',
    advisory: 'GHSA — denial of service via unbounded intermediate arrays',
  },
  {
    package: 'js-yaml',
    major: 4,
    min: '4.3.1',
    advisory: 'GHSA — quadratic CPU consumption resolving !!omap',
  },
  {
    package: 'hono',
    major: 4,
    min: '4.12.34',
    advisory: 'GHSA — ReDoS in the CORS middleware via Access-Control-Request-Headers',
  },
];

/**
 * Packages this repository forces to a version their dependents did not ask
 * for. The value has to keep a range operator, or the override becomes the
 * thing that holds a vulnerable version in place.
 */
const RANGED_OVERRIDES: readonly string[] = ['brace-expansion', 'fast-uri', 'postcss'];

const LOCKFILES: readonly string[] = ['../package-lock.json', '../web/package-lock.json'];
const MANIFESTS: readonly string[] = ['../package.json', '../web/package.json'];

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Concrete `x.y.z` out of a lockfile — never a range, so a numeric compare is enough. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

type Installed = { readonly path: string; readonly version: string };

function collectInstalled(lockfile: string, packageName: string): Installed[] {
  const packages = (readJson(lockfile)['packages'] ?? {}) as Record<string, { version?: string }>;
  const found: Installed[] = [];
  for (const [entryPath, node] of Object.entries(packages)) {
    const segments = entryPath.split('node_modules/');
    if (segments.length < 2 || segments[segments.length - 1] !== packageName) {
      continue;
    }
    const version = node.version;
    if (typeof version === 'string' && version.length > 0) {
      found.push({ path: entryPath, version });
    }
  }
  return found;
}

function label(lockfile: string): string {
  return lockfile.replace('../', '');
}

describe('dependency security floor', () => {
  for (const lockfile of LOCKFILES) {
    for (const floor of FLOORS) {
      it(`${label(lockfile)}: ${floor.package}@${floor.major}.x stays at or above ${floor.min}`, () => {
        const installed = collectInstalled(lockfile, floor.package).filter(
          (entry) => Number.parseInt(entry.version.split('.')[0] ?? '', 10) === floor.major,
        );

        // Not every package is present in every tree, and that is fine — the
        // assertion is about the copies that ARE resolved.
        for (const entry of installed) {
          expect(
            compareVersions(entry.version, floor.min),
            `${label(lockfile)} resolves ${entry.path} to ${floor.package}@${entry.version}, below the ${floor.min} that fixed ${floor.advisory}`,
          ).toBeGreaterThanOrEqual(0);
        }
      });
    }
  }

  for (const manifest of MANIFESTS) {
    it(`${label(manifest)}: forced versions are ranges, not frozen pins`, () => {
      const overrides = (readJson(manifest)['overrides'] ?? {}) as Record<string, unknown>;
      for (const packageName of RANGED_OVERRIDES) {
        const value = overrides[packageName];
        if (value === undefined) {
          continue;
        }
        expect(typeof value).toBe('string');
        expect(
          value as string,
          `${label(manifest)} pins ${packageName} to the exact version ${String(value)}. An exact override is a ceiling: when that version turns out to be the vulnerable one, nothing can move off it. Use a range such as "^${String(value)}".`,
        ).toMatch(/^[\^~]|^>=/);
      }
    });
  }
});
