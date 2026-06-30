/**
 * Advertising namespace — records advertising clicks ("the bot/Mini-App was
 * opened from a placement") against rezeis. Fire-and-forget from the caller's
 * perspective: rezeis resolves the `ad_<code>` to a placement and sets the
 * user's first-touch attribution. Best-effort — callers should swallow errors
 * so the bot welcome flow / Mini-App load never break.
 */
import type { AdminTransport } from '../transport.js';

export interface RecordAdClickInput {
  /** The `<code>` from an `ad_<code>` deep-link payload (without the prefix). */
  readonly code: string;
  readonly telegramId?: string | null;
  readonly isNewUser?: boolean;
}

export type AdPlatform =
  | 'TELEGRAM'
  | 'TELEGRAM_ADS'
  | 'YOUTUBE'
  | 'TIKTOK'
  | 'INSTAGRAM'
  | 'VK'
  | 'WEBSITE'
  | 'INFLUENCER'
  | 'OTHER';

export interface CreatePartnerAdRequestInput {
  readonly platforms: AdPlatform[];
  readonly channel?: string;
  readonly notes?: string;
  readonly proposedWindowDays: number;
  readonly selfFundedBudgetNote?: string;
}

export interface PartnerAdPlacementStat {
  readonly placementId: string;
  readonly platform: AdPlatform;
  readonly channel: string | null;
  readonly status: string;
  readonly opens: number;
  readonly registrations: number;
  readonly conversions: number;
  readonly earnedMinor: number;
}

export class AdvertisingNamespace {
  constructor(private readonly transport: AdminTransport) {}

  recordClick(input: RecordAdClickInput): Promise<{ ok: boolean }> {
    return this.transport.request<{ ok: boolean }>('POST', '/api/internal/advertising/click', {
      code: input.code,
      telegramId: input.telegramId ?? undefined,
      isNewUser: input.isNewUser ?? undefined,
    });
  }

  /** Lists the partner's own advertising requests. */
  listPartnerRequests(telegramId: string): Promise<{ requests: unknown[] }> {
    return this.transport.request<{ requests: unknown[] }>(
      'GET',
      `/api/internal/user/${encodeURIComponent(telegramId)}/advertising/requests`,
    );
  }

  /** Submits a new partner advertising request (platforms + proposed window). */
  createPartnerRequest(telegramId: string, input: CreatePartnerAdRequestInput): Promise<unknown> {
    return this.transport.request<unknown>(
      'POST',
      `/api/internal/user/${encodeURIComponent(telegramId)}/advertising/requests`,
      input,
    );
  }

  /** Per-placement stats for the partner's campaigns. */
  getPartnerStats(telegramId: string): Promise<{ placements: PartnerAdPlacementStat[] }> {
    return this.transport.request<{ placements: PartnerAdPlacementStat[] }>(
      'GET',
      `/api/internal/user/${encodeURIComponent(telegramId)}/advertising/stats`,
    );
  }
}
