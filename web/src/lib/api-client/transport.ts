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
//
// A 401 means "not authenticated". For most protected endpoints that's a
// real session expiry and we want to bounce the user to sign-in. But a few
// 401s are *expected* and the calling code already handles them:
//
//   - `GET /session`        — the unauthenticated session probe. `useSession`
//                             / WebHomePage catch this and route to /sign-in
//                             themselves. Hard-redirecting here races their
//                             catch and (because /bootstrap re-probes /session)
//                             creates a full-page reload loop that hammers the
//                             rate limiter into 429s.
//   - `/auth/*`             — login / register / recover / status. Their 401s
//                             are credential feedback for the form, not a
//                             session expiry.
//
// We also never redirect when the user is already sitting on a public / auth
// page, and we guard against firing more than once.
const PUBLIC_PATHS = [
  "/",
  "/sign-in",
  "/login",
  "/register",
  "/recover",
  "/bootstrap",
  "/tma",
  "/payment-return",
];

const BENIGN_401_PATHS = ["/session", "/auth/"];

let redirectingToSignIn = false;

function isBenign401(url: string | undefined): boolean {
  if (!url) return false;
  return BENIGN_401_PATHS.some((p) => url === p || url.startsWith(p));
}

function onPublicPage(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return PUBLIC_PATHS.some((p) => (p === "/" ? path === "/" : path.startsWith(p)));
}

apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      const reqUrl = error.config?.url as string | undefined;
      // Let the caller handle expected probe/auth 401s, and don't bounce
      // a user who's already on a public page (prevents the reload loop).
      if (!isBenign401(reqUrl) && !onPublicPage() && !redirectingToSignIn) {
        redirectingToSignIn = true;
        window.location.replace("/sign-in");
      }
    }
    return Promise.reject(error);
  },
);
