import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * reiwa's running version, read once from `package.json`.
 *
 * `package.json` lives at the package root, outside the TS `rootDir` (`src`),
 * so it can't be `import`ed. Both the container (`WORKDIR /app`) and local dev
 * run with the package root as `process.cwd()`, so we read it from there at
 * startup. Failure is non-fatal: an unreadable/garbled file falls back to
 * `0.0.0` so the version heartbeat never crashes the process.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const REIWA_VERSION = readPackageVersion();

function readBuildValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * Shorten a commit SHA to 12 chars. CI passes the full 40-char `github.sha`;
 * rezeis renders its own commit short (12), so truncating here keeps error
 * cards visually consistent across both services. `unknown`/short values pass
 * through untouched.
 */
function shortSha(sha: string): string {
  return /^[0-9a-f]{13,40}$/i.test(sha) ? sha.slice(0, 12) : sha;
}

/** Immutable identity of the running Reiwa artifact for operator events. */
export const REIWA_BUILD_INFO = Object.freeze({
  service: 'reiwa',
  version: readBuildValue('REIWA_VERSION', REIWA_VERSION),
  commit: shortSha(readBuildValue('REIWA_GIT_SHA', 'unknown')),
  branch: readBuildValue('REIWA_GIT_BRANCH', 'unknown'),
});

export function withReiwaBuildInfo(metadata?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    ...REIWA_BUILD_INFO,
  };
}
