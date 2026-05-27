/**
 * Forward-declared port for the typed AdminClient namespace facade.
 *
 * Wave 2 landed the concrete namespaces on
 * `infrastructure/admin-client/`. This port stays as a marker until
 * Wave 3+ formalises the namespace contracts (one interface per
 * namespace, e.g. `UserNamespacePort`, `PaymentsNamespacePort`).
 * Use cases and DI containers should depend on the concrete classes
 * exported from `infrastructure/admin-client/namespaces/index.js` for
 * now; the port type is used only for slot reservation.
 */
export interface AdminClientPort {
  /**
   * Marker — concrete namespace ports are introduced in Wave 3+ when
   * use cases start depending on AdminClient via DI rather than
   * importing the concrete class directly.
   */
  readonly _wave2Marker: 'see-infrastructure-admin-client';
}
