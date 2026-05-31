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
