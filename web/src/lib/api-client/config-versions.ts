/**
 * Which version of each panel settings group the cabinet holds —
 * `GET /api/v1/config-versions`, answered from the API process's memory and
 * never cached (`src/api/app.ts`). Read by the version watcher
 * (`lib/config-versions.ts`); a short timeout, because an ask that hangs only
 * delays the next one.
 */
import { apiClient } from "./transport.js";

export const getConfigVersions = () =>
  apiClient.get<unknown>("/config-versions", { timeout: 10_000 }).then((r) => r.data);
