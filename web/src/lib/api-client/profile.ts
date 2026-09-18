/**
 * Profile namespace — name, language, email-verification flow. A password
 * changes through `auth.changePasswordAuth` (`/auth/change-password`); the old
 * `PATCH /me/password` asked for no proof and is gone.
 */
import { apiClient } from "./transport.js";

export const updateProfile = (data: { name?: string }) =>
  apiClient.patch("/me/profile", data).then((r) => r.data);

export const updateLanguage = (language: string) =>
  apiClient.patch("/me/language", { language }).then((r) => r.data);

export const requestEmailVerification = (email: string) =>
  apiClient.post("/me/email/challenge", { email }).then((r) => r.data);

export const completeEmailVerification = (code: string) =>
  apiClient.patch("/me/email/verify", { code }).then((r) => r.data);
