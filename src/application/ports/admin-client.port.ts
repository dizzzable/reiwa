/**
 * Forward-declared port for the typed AdminClient namespace facade.
 *
 * Wave 2 will populate this with concrete sub-ports
 * (`UserNamespace`, `SubscriptionNamespace`, `PaymentsNamespace`, ...)
 * built around the existing `infrastructure/admin-client/admin-client.ts`.
 *
 * Keeping the empty marker in Wave 1 lets `application/use-cases/*` reference
 * the eventual port type without forcing a circular import or premature
 * commitment to namespace shapes.
 */
export interface AdminClientPort {
  /**
   * Marker — concrete namespaces (`user`, `subscription`, `payments`,
   * `referrals`, `linking`, `webAuth`, `botConfig`, `branding`,
   * `promocodes`, `partner`, `notifications`, `platform`, `push`,
   * `worker`) are added in Wave 2.
   */
  readonly _wave1Marker: 'see-wave-2';
}
