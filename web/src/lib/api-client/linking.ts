/**
 * Linking namespace — opt-in identity-channel attachments for the
 * logged-in `reiwa_id`.
 *
 *   - Telegram: `initiateTelegramLink()` mints a single-use 6-digit
 *     code the user submits to the bot (`t.me/<bot>?start=link_<code>`
 *     deep-link or by pasting the code). The bot consumes it and
 *     attaches `User.telegramId` to the web-first account.
 *
 *   - Email: `initiateEmailLink(email)` issues a 6-digit code by email;
 *     `verifyEmailLink(code)` stamps `WebAccount.emailVerifiedAt` so
 *     the address becomes a usable password-recovery channel.
 *
 * All three routes require an authenticated web session and proxy to
 * rezeis-admin via the reiwa BFF (`/api/v1/link/*`).
 */
import { apiClient } from "./transport.js";

export interface TelegramLinkInitiateResponse {
  code: string;
  expiresAt: string;
  botUsername: string | null;
}

export interface EmailLinkInitiateResponse {
  success: boolean;
  message: string;
}

export interface EmailLinkVerifyResponse {
  success: boolean;
  verified: boolean;
}

export const initiateTelegramLink = () =>
  apiClient
    .post<TelegramLinkInitiateResponse>("/link/telegram/initiate")
    .then((r) => r.data);

export const initiateEmailLink = (email: string) =>
  apiClient
    .post<EmailLinkInitiateResponse>("/link/email/initiate", { email })
    .then((r) => r.data);

export const verifyEmailLink = (code: string) =>
  apiClient
    .post<EmailLinkVerifyResponse>("/link/email/verify", { code })
    .then((r) => r.data);
