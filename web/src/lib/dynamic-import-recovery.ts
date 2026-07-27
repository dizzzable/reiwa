/**
 * A deployed SPA can retain an old entry document while a lazy route's hashed
 * chunk has already been replaced. Safari reports that as a failed module
 * import rather than a normal HTTP error. Reloading once fetches the current
 * entry document; recording the failed signature in session storage prevents
 * a missing asset from trapping the user in a reload loop.
 */

const RECOVERY_STORAGE_KEY = 'reiwa.dynamic-import-recovery.v1';
const MAX_REMEMBERED_FAILURES = 8;

interface RecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface RecoveryEnvironment {
  readonly storage: RecoveryStorage;
  readonly reload: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/** True only for browser messages caused by a lazy ES-module fetch failing. */
export function isDynamicImportFailure(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    /failed to (fetch|load) dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message)
  );
}

function getDefaultEnvironment(): RecoveryEnvironment | null {
  if (typeof window === 'undefined') return null;
  try {
    return {
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    };
  } catch {
    // Safari private browsing can reject storage access. Showing the normal
    // error screen is safer than attempting an unguarded reload in that case.
    return null;
  }
}

function readRememberedFailures(storage: RecoveryStorage): string[] {
  try {
    const raw = storage.getItem(RECOVERY_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Reloads once per failed import signature in the current tab session.
 *
 * The optional environment is deliberately small so the loop guard can be
 * tested without a browser DOM.
 */
export function recoverFromDynamicImportFailure(
  error: unknown,
  environment: RecoveryEnvironment | null = getDefaultEnvironment(),
): boolean {
  if (!isDynamicImportFailure(error) || environment === null) return false;

  const signature = getErrorMessage(error).trim().slice(0, 1_000);
  if (signature.length === 0) return false;

  try {
    const remembered = readRememberedFailures(environment.storage);
    if (remembered.includes(signature)) return false;

    environment.storage.setItem(
      RECOVERY_STORAGE_KEY,
      JSON.stringify([...remembered, signature].slice(-MAX_REMEMBERED_FAILURES)),
    );
    environment.reload();
    return true;
  } catch {
    return false;
  }
}
