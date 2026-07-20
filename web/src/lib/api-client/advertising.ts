/**
 * Advertising namespace — Mini-App / web click ingest + partner self-service
 * (submit requests, accept counters, list own requests, per-placement stats).
 */
import { apiClient } from "./transport.js";

export type AdPlatform =
  | "TELEGRAM"
  | "TELEGRAM_ADS"
  | "YOUTUBE"
  | "TIKTOK"
  | "INSTAGRAM"
  | "VK"
  | "WEBSITE"
  | "INFLUENCER"
  | "OTHER";

export interface PartnerAdRequest {
  id: string;
  platforms: AdPlatform[];
  channel: string | null;
  notes: string | null;
  proposedWindowDays: number;
  approvedWindowDays: number | null;
  status: string;
  createdAt: string;
}

export interface AdDeepLinks {
  botStart: string;
  miniAppStart: string | null;
  miniAppWeb: string | null;
}

export interface PartnerAdPlacementStat {
  placementId: string;
  platform: AdPlatform;
  channel: string | null;
  status: string;
  trackingCode: string;
  payload: string;
  links: AdDeepLinks;
  opens: number;
  registrations: number;
  conversions: number;
  earnedMinor: number;
}

export interface CreatePartnerAdRequestInput {
  platforms: AdPlatform[];
  channel?: string;
  notes?: string;
  proposedWindowDays: number;
  selfFundedBudgetNote?: string;
}

/** Best-effort: records a Mini-App / web open carrying an `ad_<code>` param. */
export const recordAdClick = (code: string, surface?: "BOT" | "MINIAPP" | "WEB") =>
  apiClient
    .post<{ ok: boolean }>("/advertising/click", { code, surface })
    .then((r) => r.data);

export const getPartnerAdRequests = () =>
  apiClient
    .get<{ requests: PartnerAdRequest[] }>("/advertising/requests")
    .then((r) => r.data);

export const createPartnerAdRequest = (input: CreatePartnerAdRequestInput) =>
  apiClient.post<PartnerAdRequest>("/advertising/requests", input).then((r) => r.data);

export const acceptPartnerAdRequest = (requestId: string) =>
  apiClient
    .post<unknown>(`/advertising/requests/${encodeURIComponent(requestId)}/accept`, {})
    .then((r) => r.data);

export const getPartnerAdStats = () =>
  apiClient
    .get<{ placements: PartnerAdPlacementStat[] }>("/advertising/stats")
    .then((r) => r.data);
