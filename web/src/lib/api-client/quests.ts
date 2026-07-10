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
