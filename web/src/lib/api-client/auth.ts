/**
 * Auth namespace — login, register, recovery, sign-out, password change,
 * status probe, Telegram bootstrap.
 *
 * Pure HTTP + DTO shaping; no React state. Components consume via
 * React Query.
 */
import { apiClient } from "./transport.js";
import type { ReiwaSession } from "@/types/api";

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
export const bootstrapTelegram = (initData: string) =>
  apiClient
    .post<{ ok: boolean; user: ReiwaSession }>(
      "/auth/telegram/bootstrap",
      undefined,
      { headers: { Authorization: `tma ${initData}` } },
    )
    .then((r) => r.data);

// ── Login / sign-out ─────────────────────────────────────────────────────────
export const login = (data: LoginRequest) =>
  apiClient.post<LoginResponse>("/auth/login", data).then((r) => r.data);

export const signOut = () =>
  apiClient.post("/auth/sign-out").then((r) => r.data);

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
) =>
  apiClient
    .post<RegisterResponse>("/auth/register", {
      username,
      passwordHash,
      ...(checkOnly ? { checkOnly: true } : {}),
    })
    .then((r) => r.data);

export const recoverPassword = (username: string) =>
  apiClient
    .post<RecoverResponse>("/auth/recover", { username })
    .then((r) => r.data);
