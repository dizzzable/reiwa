/**
 * External-auth namespace — end-user social sign-in / registration for the web
 * cabinet. Talks to the rezeis `internal/ext-auth` surface. Client secrets stay
 * on rezeis: the BFF only forwards codes / pre-verified Telegram identities and
 * receives a login/finish_setup/denied decision.
 */
import type { AdminTransport } from '../transport.js';

export type ExternalAuthProvider = 'TELEGRAM' | 'GOOGLE' | 'YANDEX' | 'MAILRU';

export interface PublicExternalProvider {
  readonly provider: ExternalAuthProvider;
  readonly displayName: string;
  /** Telegram only: `oidc` (redirect) vs `widget` (classic Login Widget). */
  readonly mode?: 'oidc' | 'widget';
}

export type ExternalAuthResolution =
  | { readonly action: 'login'; readonly userId: string }
  | { readonly action: 'finish_setup'; readonly userId: string }
  | { readonly action: 'denied' };

export class ExtAuthNamespace {
  constructor(private readonly transport: AdminTransport) {}

  listProviders(): Promise<PublicExternalProvider[]> {
    return this.transport.request<PublicExternalProvider[]>(
      'GET',
      '/api/internal/ext-auth/providers',
    );
  }

  authorizeUrl(input: {
    readonly provider: ExternalAuthProvider;
    readonly state: string;
    readonly redirectUri: string;
    readonly codeChallenge?: string;
  }): Promise<{ url: string }> {
    return this.transport.request<{ url: string }>(
      'POST',
      '/api/internal/ext-auth/authorize-url',
      input,
    );
  }

  resolveOAuth(input: {
    readonly provider: ExternalAuthProvider;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier?: string;
  }): Promise<ExternalAuthResolution> {
    return this.transport.request<ExternalAuthResolution>(
      'POST',
      '/api/internal/ext-auth/oauth/resolve',
      input,
    );
  }

  resolveTelegram(input: {
    readonly providerUserId: string;
    readonly name?: string;
  }): Promise<ExternalAuthResolution> {
    return this.transport.request<ExternalAuthResolution>(
      'POST',
      '/api/internal/ext-auth/telegram/resolve',
      input,
    );
  }

  finishSetup(input: {
    readonly userId: string;
    readonly login: string;
    readonly passwordHash: string;
  }): Promise<{ ok: true }> {
    return this.transport.request<{ ok: true }>(
      'POST',
      '/api/internal/ext-auth/finish-setup',
      input,
    );
  }
}
