import { apiClient } from "./transport.js";

export interface DeviceSignalsPayload {
  readonly installId: string | null;
  readonly deviceHash: string | null;
}

/**
 * Best-effort report of the browser's device signals.
 *
 * ── The response carries nothing, on purpose ─────────────────────────────
 *
 * `{ ok: true }` whether the signals were stored, rejected as malformed, or
 * matched a machine that also belongs to a blocked account and marked this one
 * for an operator. The mark is only worth having while the person carrying it
 * cannot tell: an answer that differed would let somebody probe which of the
 * two signals identifies them and change it before the next attempt.
 *
 * That is also why the caller never renders anything from this — there is
 * nothing here to render.
 */
export const reportDeviceSignals = (payload: DeviceSignalsPayload) =>
  apiClient
    .post<{ ok: boolean }>("/device-signals", payload)
    .then((r) => r.data);
