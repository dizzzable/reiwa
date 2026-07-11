/**
 * Quests (gamification) namespace — the cabinet entry-icon list + claim, and
 * the sanitized-icon URL helper. Same-origin; the session cookie authenticates.
 */
import { apiClient } from "./transport.js";

export type QuestType =
  | "LINK_TELEGRAM"
  | "LINK_EMAIL"
  | "INVITE_FRIENDS"
  | "SUBSCRIBE_CHANNEL"
  | "PARTNER_TASK"
  | "CUSTOM";

export type QuestRewardType = "POINTS" | "DAYS" | "PROMOCODE" | "DISCOUNT" | "TRAFFIC";

export type QuestPartnerMethod = "manual_code" | "postback" | "timed_visit";

export interface QuestLocalizedText {
  ru: string;
  en: string;
}

export interface QuestCabinetItem {
  id: string;
  type: QuestType;
  title: QuestLocalizedText;
  description: QuestLocalizedText;
  iconKind: "PRESET" | "SVG";
  iconRef: string;
  rewardType: QuestRewardType;
  rewardAmount: number;
  status: "IN_PROGRESS" | "COMPLETED";
  progress: number;
  requiredFriends?: number;
  /** PARTNER_TASK only — how the cabinet verifies the task. */
  partnerMethod?: QuestPartnerMethod;
  /** PARTNER_TASK only — operator-approved https landing URL. */
  partnerUrl?: string;
  /** PARTNER_TASK timed_visit — seconds to dwell before confirm unlocks. */
  partnerVisitSeconds?: number;
  claimable: boolean;
}

export interface QuestCabinetResponse {
  pointsBalance: number;
  quests: QuestCabinetItem[];
}

export interface QuestClaimResult {
  questId: string;
  rewardType: QuestRewardType;
  points?: number;
  days?: number;
  discountPercent?: number;
  trafficGb?: number;
  promoCode?: string;
  subscriptionId?: string;
}

/** Same-origin URL for a sanitized quest icon (SVG). Rendered via `<img>`. */
export const questIconUrl = (iconId: string): string =>
  `/api/v1/quests/icons/${encodeURIComponent(iconId)}`;

export const getQuests = (): Promise<QuestCabinetResponse> =>
  apiClient.get<QuestCabinetResponse>("/quests").then((r) => r.data);

export const claimQuest = (questId: string): Promise<QuestClaimResult> =>
  apiClient
    .post<QuestClaimResult>(`/quests/${encodeURIComponent(questId)}/claim`)
    .then((r) => r.data);

/** Partner verification result — the cabinet only needs the resulting state. */
export interface QuestPartnerVerifyResult {
  state: "IN_PROGRESS" | "COMPLETED" | "CLAIMED";
}

export interface QuestPartnerVisitStart {
  landingUrl: string | null;
}

/** manual_code: submit the code the user entered (session identity, not body). */
export const submitPartnerCode = (
  questId: string,
  code: string,
): Promise<QuestPartnerVerifyResult> =>
  apiClient
    .post<QuestPartnerVerifyResult>(`/quests/${encodeURIComponent(questId)}/partner/code`, { code })
    .then((r) => r.data);

/** timed_visit: record the server-authoritative visit start. */
export const startPartnerVisit = (questId: string): Promise<QuestPartnerVisitStart> =>
  apiClient
    .post<QuestPartnerVisitStart>(`/quests/${encodeURIComponent(questId)}/partner/visit/start`)
    .then((r) => r.data);

/** timed_visit: confirm the visit once the dwell has elapsed. */
export const confirmPartnerVisit = (questId: string): Promise<QuestPartnerVerifyResult> =>
  apiClient
    .post<QuestPartnerVerifyResult>(`/quests/${encodeURIComponent(questId)}/partner/visit/complete`)
    .then((r) => r.data);
