import type { AdminTransport } from '../transport.js';
import type { UserIdentity } from './subscription.js';

export interface OlcrtcSubscriptionResponse {
  readonly enabled: boolean;
  readonly eligible: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly subscription: {
    readonly sessionId: string;
    readonly subscriptionId: string;
    readonly profileId: string;
    readonly provider: string;
    readonly transport: string;
    readonly url: string;
    readonly refreshSeconds: number;
    readonly expiresAt: string | null;
  } | null;
}

function identityQuery(identity: UserIdentity): string {
  if (typeof identity.userId === 'string' && identity.userId.length > 0) {
    return `userId=${encodeURIComponent(identity.userId)}`;
  }
  if (typeof identity.telegramId === 'string' && identity.telegramId.length > 0) {
    return `telegramId=${encodeURIComponent(identity.telegramId)}`;
  }
  return '';
}

export class OlcrtcNamespace {
  constructor(private readonly transport: AdminTransport) {}

  getSubscription(identity: UserIdentity): Promise<OlcrtcSubscriptionResponse> {
    return this.transport.request(
      'GET',
      `/api/internal/olcrtc/subscription?${identityQuery(identity)}`,
    );
  }

  provisionSubscription(identity: UserIdentity): Promise<OlcrtcSubscriptionResponse> {
    return this.transport.request(
      'POST',
      `/api/internal/olcrtc/subscription/provision?${identityQuery(identity)}`,
    );
  }
}
