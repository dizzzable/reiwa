/**
 * External-auth namespace — social sign-in / registration for the web cabinet.
 * OAuth flows are full-page redirects (see `EXT_START_PATH`); this module only
 * covers the JSON calls: listing enabled providers and finishing setup.
 */
import { apiClient } from "./transport.js";

export type ExternalAuthProvider = "TELEGRAM" | "GOOGLE" | "YANDEX" | "MAILRU";

export interface PublicExternalProvider {
  provider: ExternalAuthProvider;
  displayName: string;
  /** Telegram only: `oidc` (redirect) vs `widget` (classic Login Widget). */
  mode?: "oidc" | "widget";
}

/** Full-page redirect entry point for an OAuth provider (not an XHR). */
export const externalStartPath = (provider: string): string =>
  `/api/v1/auth/ext/${provider.toLowerCase()}/start`;

/** Telegram Login Widget callback URL (the widget redirects here itself). */
export const externalTelegramCallbackPath = (): string =>
  `/api/v1/auth/ext/telegram/callback`;

export const getExternalProviders = () =>
  apiClient
    .get<{ providers: PublicExternalProvider[] }>("/auth/ext/providers")
    .then((r) => r.data.providers);

export const finishExternalSetup = (input: { username: string; passwordHash: string }) =>
  apiClient
    .post<{ success: boolean; redirectUrl: string }>("/auth/ext/finish-setup", input)
    .then((r) => r.data);
