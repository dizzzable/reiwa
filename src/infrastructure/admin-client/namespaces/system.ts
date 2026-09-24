/**
 * System namespace — health probe + global settings (platform policy,
 * registration toggle) and the worker pull endpoint that doesn't fit
 * any user-scoped namespace.
 */
import type { AdminTransport } from '../transport.js';

/** Canonical platform access mode mirrored from rezeis-admin Prisma enum. */
export type AccessMode =
  | 'PUBLIC'
  | 'INVITED'
  | 'PURCHASE_BLOCKED'
  | 'REG_BLOCKED'
  | 'RESTRICTED';

/**
 * Wire shape of `GET /api/internal/settings/platform-policy`. Mirrors
 * rezeis-admin's `InternalPlatformPolicyInterface`. Kept narrow on purpose
 * — only fields the reiwa edge actually consumes.
 */
export interface PlatformPolicyShape {
  readonly accessMode: AccessMode;
  readonly rulesRequired: boolean;
  readonly rulesLink: string | null;
  readonly channelRequired: boolean;
  readonly channelLink: string | null;
  /**
   * «ID канала». rezeis sends `null` when it is empty — the usual setup, with
   * only the link filled — so `null` must read as "not set", never as an id.
   */
  readonly channelId?: string | number | null;
  readonly channelUsername?: string | null;
  readonly channelRecheck?: boolean;
  /**
   * When true (default), Telegram users without web login/password must set
   * them before entering the cabinet; when false, Telegram alone suffices.
   * Consumed by the cabinet's route guard.
   */
  readonly requireTelegramWebCredentials?: boolean;
  /**
   * «Восстановление пароля по ссылке подписки» — the operator's switch. A
   * panel that predates it sends nothing, and the cabinet reads that as OFF:
   * such a panel has no subscription-recovery endpoint either.
   */
  readonly subscriptionLinkRecovery?: boolean;
  readonly defaultCurrency: string;
}

export class SystemNamespace {
  constructor(private readonly transport: AdminTransport) {}

  test(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/test');
  }

  getPlatformPolicy(): Promise<PlatformPolicyShape> {
    return this.transport.request<PlatformPolicyShape>(
      'GET',
      '/api/internal/settings/platform-policy',
    );
  }

  getRegistrationToggle(): Promise<{ enabled: boolean }> {
    return this.transport.request<{ enabled: boolean }>(
      'GET',
      '/api/internal/settings/registration-toggle',
    );
  }

  getExpiryAlerts(): Promise<unknown> {
    return this.transport.request('GET', '/api/internal/worker/expiry-alerts');
  }

  /**
   * Reports reiwa's running version to the admin panel so its "Updates"
   * widget can show the live reiwa version next to the latest release.
   * Fire-and-forget on the caller side — failures are non-critical.
   */
  reportReiwaVersion(version: string): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/system/reiwa-version', { version });
  }

  /**
   * The version poll (`infrastructure/config-versions/poller.ts`): sends which
   * version of each settings group this process holds, and gets back the
   * panel's `{ versions: { <group>: <version> } }`. A panel that predates the
   * route answers 404, which the poller reads as "not supported".
   */
  pollConfigVersions(report: {
    readonly consumer: 'api' | 'bot';
    readonly held: Readonly<Record<string, string | null>>;
  }): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/config-versions', report);
  }

  /**
   * Report a reiwa runtime error/warning to rezeis so it's captured centrally
   * as a system event (audit log → Events page → .txt export). Fire-and-forget
   * — callers must never block on or throw from this.
   */
  reportError(input: {
    readonly source: 'api' | 'bot' | 'worker' | 'web';
    readonly message: string;
    readonly level?: 'error' | 'warning';
    readonly context?: Record<string, unknown>;
    readonly stack?: string;
  }): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/system/error', input);
  }
}
