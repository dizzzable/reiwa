/**
 * Connect-page namespace — the catalog behind the connect screen.
 *
 * The BFF serves either the catalog or `null` (panel unreachable), and the
 * shape is returned untyped here: it is re-read fail-closed by
 * `features/connect/connect-catalog.ts`, so a panel one release ahead can add a
 * button kind this cabinet has never seen without breaking the screen.
 */
import { apiClient } from "./transport.js";

export const getConnectPage = () =>
  apiClient.get<unknown>("/connect-page").then((r) => r.data);

/**
 * Whether this cabinet signed the subscription inside a `/connect/open`
 * address — asked by that page, which has no session.
 *
 * The body is built field by field rather than passed through: exactly the
 * SHA-256 of the subscription URL and the signature, so nothing a caller adds —
 * the URL, the link — can ride along (`features/connect/connect-trampoline.ts`).
 */
export const verifyConnectHandoff = (input: { digest: string; signature: string }) =>
  apiClient
    .post<{ valid: boolean }>("/connect/handoff/verify", {
      digest: input.digest,
      signature: input.signature,
    })
    .then((r) => r.data);
