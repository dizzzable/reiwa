/**
 * Resolve a transport-ambiguous DELETE exactly once. Subscription deletion is
 * idempotent server-side, so a second request can confirm a commit whose first
 * response was lost. Explicit HTTP failures are left to the caller.
 */
export async function executeSubscriptionDeleteWithAmbiguousRetry<T>(
  operation: () => Promise<T>,
  isAmbiguousTransportError: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (!isAmbiguousTransportError(error)) throw error;
    return operation();
  }
}
