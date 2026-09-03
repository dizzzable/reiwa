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
