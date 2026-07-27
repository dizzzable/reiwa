/**
 * A browser-only, last-known-good copy of the public bootstrap payload.
 *
 * React Query intentionally keeps its cache in memory only. This snapshot
 * lets a cold SPA start with the last operator theme while the first request
 * is still in flight. It contains public configuration only and is never a
 * source of truth over a successfully fetched response.
 */

import { isPublicConfigSnapshot } from "../../../src/application/ports/public-config-persistence.port";
import type { PublicConfig } from "@/types/branding";

const STORAGE_KEY = "reiwa_public_config_snapshot_v1";
const MAX_SNAPSHOT_LENGTH = 512_000;

export function readPublicConfigSnapshot(): PublicConfig | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_SNAPSHOT_LENGTH) return null;

    const value: unknown = JSON.parse(raw);
    return isPublicConfig(value) ? value : null;
  } catch {
    // Private browsing, a full storage quota, or an edited/corrupt value must
    // never stop the cabinet from falling back to its built-in defaults.
    return null;
  }
}

export function writePublicConfigSnapshot(config: PublicConfig): void {
  if (!isPublicConfig(config)) return;

  const storage = getLocalStorage();
  if (!storage) return;

  try {
    const serialized = JSON.stringify(config);
    if (serialized.length <= MAX_SNAPSHOT_LENGTH) {
      storage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // Persistence is an enhancement only; storage errors must be non-fatal.
  }
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPublicConfig(value: unknown): value is PublicConfig {
  return isPublicConfigSnapshot(value);
}
