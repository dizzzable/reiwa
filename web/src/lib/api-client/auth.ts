/**
 * Auth namespace — login, register, recovery, sign-out, password change,
 * status probe, Telegram bootstrap.
 *
 * Pure HTTP + DTO shaping; no React state. Components consume via
 * React Query.
 */
import { apiClient } from "./transport.js";

export interface LoginRequest {
  username: string;
  passwordHash: string;
}

export interface LoginResponse {
  success: boolean;
  redirectUrl: string;
  requiresPasswordChange: boolean;
  suppressErrors?: boolean;
  suppressPasswordChangeRedirect?: boolean;
}

export interface RegisterResponse {
  success: boolean;
  redirectUrl: string;
}

export interface ClaimResponse {
  success: boolean;
  userId: string;
  redirectUrl: string;
}

export interface RecoverResponse {
  method: "telegram" | "email" | "none";
  message: string;
}

export interface AuthStatusResponse {
  isRegistrationEnabled: boolean;
  isAuthenticated: boolean;
  context: "tma" | "web";
}

// ── Web password change ──────────────────────────────────────────────────────
export const changePasswordAuth = (data: {
  currentPasswordHash: string;
  newPasswordHash: string;
}) =>
  apiClient.post("/auth/change-password", data).then((r) => r.data);

// ── Telegram-init-data bootstrap ─────────────────────────────────────────────
// Validates initData server-side and mints a WebSession (same model as
// web login / magic-link). Returns the redirect target; the session cookie
// is set as a side-effect, so the SPA refetches `/session` afterwards.
export const bootstrapTelegram = (initData: string) =>
  apiClient
    .post<{ ok: boolean; redirectUrl?: string }>(
      "/auth/telegram/bootstrap",
      undefined,
      { headers: { Authorization: `tma ${initData}` } },
    )
    .then((r) => r.data);

// ── Login / sign-out ─────────────────────────────────────────────────────────
export const login = (data: LoginRequest) =>
  apiClient.post<LoginResponse>("/auth/login", data).then((r) => r.data);

// Canonical logout: destroys the web session (and any legacy bot session)
// and is idempotent — it never 401s on an already-expired/absent session,
// so the user can always sign out cleanly.
export const signOut = () =>
  apiClient.post("/auth/logout").then((r) => r.data);

// ── Bot magic-link sign-in ───────────────────────────────────────────────────
//
// Reiwa-bot embeds a one-time `?signin=<token>` query parameter into
// the Cabinet URL it shows in Telegram. The SPA root page detects the
// param, calls this endpoint to exchange the token for a real
// WebSession cookie, then strips the param from the URL and routes
// the user to /dashboard.
//
// Token format: 64 hex chars (32 random bytes). Errors come back as
// 401 — caller falls through to /sign-in (with optional error hint).
export interface BotSigninResponse {
  readonly success: boolean;
  readonly redirectUrl?: string;
  readonly message?: string;
}
export const botSignin = (token: string) =>
  apiClient
    .post<BotSigninResponse>("/auth/bot-signin", { token })
    .then((r) => r.data);

// ── Status / register / recover ──────────────────────────────────────────────
export const getAuthStatus = () =>
  apiClient.get<AuthStatusResponse>("/auth/status").then((r) => r.data);

export const registerUser = (
  username: string,
  passwordHash: string,
  checkOnly?: boolean,
  referralCode?: string,
) =>
  apiClient
    .post<RegisterResponse>("/auth/register", {
      username,
      passwordHash,
      ...(checkOnly ? { checkOnly: true } : {}),
      ...(referralCode ? { referralCode } : {}),
    })
    .then((r) => r.data);

/**
 * Non-mutating username availability probe. Unlike the old approach
 * (a real `registerUser` with a dummy hash, which created junk accounts
 * and burned the 3/h register limit), this hits a read-only endpoint.
 */
export const checkUsername = (username: string) =>
  apiClient
    .post<{ available: boolean }>("/auth/check-username", { username })
    .then((r) => r.data);

export const recoverPassword = (username: string) =>
  apiClient
    .post<RecoverResponse>("/auth/recover", { username })
    .then((r) => r.data);

// ── Claim (mandatory first-entry onboarding) ─────────────────────────────────
//
// A Telegram-first user (authenticated via Mini App bootstrap / magic-link
// into a WebSession) sets login + password so they can also reach their
// account from a browser. The reiwa BFF takes the userId from the server-side
// WebSession, NEVER the body, so this can only attach credentials to the
// caller's own account. 409 = login taken / already claimed; 400 = invalid.
export const claimAccount = (username: string, passwordHash: string) =>
  apiClient
    .post<ClaimResponse>("/auth/claim", { username, passwordHash })
    .then((r) => r.data);
