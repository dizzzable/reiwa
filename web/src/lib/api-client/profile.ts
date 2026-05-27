/**
 * Profile namespace — name, language, password, email-verification flow.
 */
import { apiClient } from "./transport.js";

export const updateProfile = (data: { name?: string }) =>
  apiClient.patch("/me/profile", data).then((r) => r.data);

export const updateLanguage = (language: string) =>
  apiClient.patch("/me/language", { language }).then((r) => r.data);

export const changePassword = (newPasswordHash: string) =>
  apiClient.patch("/me/password", { newPasswordHash }).then((r) => r.data);

export const requestEmailVerification = (email: string) =>
  apiClient.post("/me/email/challenge", { email }).then((r) => r.data);

export const completeEmailVerification = (code: string) =>
  apiClient.patch("/me/email/verify", { code }).then((r) => r.data);
