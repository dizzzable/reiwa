import { clearAppBadge } from '@/lib/app-badge';

export interface DeletedUserSessionTermination {
  readonly closeRealtime: () => void;
  readonly clearPendingInvalidations: () => void;
  readonly cancelQueries: () => Promise<unknown>;
  readonly clearQueryCache: () => void;
  readonly signOut: () => Promise<unknown>;
  readonly redirectToSignIn: () => void;
}

/**
 * Ends every local source of work for an account that Rezeis has deleted.
 *
 * The logout call is best-effort because redirecting with an old cookie would
 * be worse than redirecting after a Redis hiccup. Reiwa's logout endpoint also
 * clears the browser cookie in its failure path.
 */
export async function terminateDeletedUserSession(
  dependencies: DeletedUserSessionTermination,
): Promise<void> {
  dependencies.closeRealtime();
  dependencies.clearPendingInvalidations();
  // The home-screen icon, cleared here and nowhere else on this path: it ends
  // in `window.location.replace`, a full document navigation that gives no
  // React effect a chance to run. For a deleted account there is also nothing
  // coming later to correct it — no push will ever arrive again — so a number
  // left on the icon stays there for good.
  void clearAppBadge();

  try {
    await dependencies.cancelQueries();
  } catch {
    // Cache teardown below is still mandatory when an individual transport
    // cannot be cancelled cleanly.
  }
  dependencies.clearQueryCache();

  try {
    await dependencies.signOut();
  } catch {
    // Local teardown + redirect are the terminal contract. The idempotent
    // logout endpoint clears cookies even when its server-side cleanup fails.
  } finally {
    dependencies.redirectToSignIn();
  }
}
