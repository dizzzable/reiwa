/**
 * A browser-only, last-known-good copy of the public bootstrap payload.
 *
 * React Query intentionally keeps its cache in memory only. This snapshot
 * lets a cold SPA start with the last operator theme while the first request
 * is still in flight. It contains public configuration only and is never a
 * source of truth over a successfully fetched response.
 */

import {
  DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID,
  DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH,
  isPublicConfigSnapshot,
} from "../../../src/application/ports/public-config-persistence.port";
import type { PublicConfig } from "@/types/branding";

const STORAGE_KEY = "reiwa_public_config_snapshot_v1";
const MAX_SNAPSHOT_LENGTH = 512_000;

/**
 * The public config the API wrote into this document (`api/document-public-config.ts`):
 * the server's current copy, so fresher than this browser's own snapshot and —
 * the reason it exists — present for a visitor who has none. `null` when the
 * document carries none (served while the server had no config) or it does
 * not validate; like the snapshot, never a source of truth over a response.
 */
export function readDocumentPublicConfig(): PublicConfig | null {
  if (typeof document === "undefined") return null;
  try {
    const raw = document.getElementById(DOCUMENT_PUBLIC_CONFIG_ELEMENT_ID)?.textContent;
    if (!raw || raw.length > DOCUMENT_PUBLIC_CONFIG_MAX_LENGTH) return null;
    const value: unknown = JSON.parse(raw);
    return isPublicConfig(value) ? value : null;
  } catch {
    return null;
  }
}

/** What the first render starts from: the document's copy, else this browser's snapshot, else nothing. */
export function readInitialPublicConfig(): PublicConfig | null {
  return readDocumentPublicConfig() ?? readPublicConfigSnapshot();
}

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
