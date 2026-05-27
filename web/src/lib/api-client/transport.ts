/**
 * Shared axios instance for the SPA.
 *
 * Wave 5 split the per-domain functions into namespace files under
 * `lib/api-client/`. They all consume this single transport so:
 *   - the session cookie is sent on every request (`withCredentials`)
 *   - the response interceptor catches 401 globally and bounces to
 *     `/bootstrap`
 *   - a fresh `x-request-id` is attached to every outbound call so the
 *     reiwa API and rezeis-admin can correlate logs end-to-end (Wave 4
 *     installed the server side; this is the SPA half).
 *
 * Components must depend on the namespace functions (`auth.login(...)`,
 * `payments.createCheckout(...)`) rather than the raw `apiClient`. The
 * legacy free-function exports in `../api-client.ts` re-export through
 * here for back-compat until Wave 6 removes them.
 */
import axios from "axios";

export const apiClient = axios.create({
  baseURL: "/api/v1",
  withCredentials: true, // send reiwa_session cookie automatically
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// ── Request-id propagation ────────────────────────────────────────────────────
// Generate a fresh UUID v4 per outgoing request and attach it as
// `x-request-id`. The reiwa API echoes it back; the SPA can then
// surface the id in error toasts / bug reports so on-call has a single
// trace key spanning browser → reiwa-api → rezeis-admin.
//
// `crypto.randomUUID()` is available in every browser TanStack Query
// supports (Chrome 92+, Safari 15.4+, Firefox 95+) and in Node 19+.
apiClient.interceptors.request.use((config) => {
  if (!config.headers["x-request-id"]) {
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    config.headers["x-request-id"] = id;
  }
  return config;
});

// ── Response interceptor — handle session expiry ──────────────────────────────
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      // Clear any local state and redirect to bootstrap. The reiwa
      // bootstrap page detects context (TMA vs web) and routes onward.
      window.location.replace("/bootstrap");
    }
    return Promise.reject(error);
  },
);
