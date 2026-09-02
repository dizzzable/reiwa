/**
 * Wheel of fortune namespace — the cabinet's own view, the spin, buying spins
 * with points, and the person's history. Same-origin; the session cookie
 * authenticates.
 *
 * The odds are absent from every shape here on purpose: the server never
 * sends them, and there is nowhere for them to land if it ever tried.
 */
import { apiClient } from "./transport.js";

export type WheelSectorKind =
  | "NOTHING"
  | "POINTS"
  | "SPINS"
  | "DAYS"
  | "TRAFFIC"
  | "DISCOUNT"
  | "PROMOCODE"
  | "KEY"
  | "MANUAL";

export type WheelRarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY";

export type WheelSpinStatus = "EMPTY" | "SETTLED" | "PENDING" | "REFUSED";

/** Why a sector is greyed out for this person. */
export type SectorUnavailable = "ALREADY_WON" | "ALL_GONE";

export interface WheelLocalizedText {
  ru?: string;
  en?: string;
}

export interface WheelSector {
  id: string;
  kind: WheelSectorKind;
  title: WheelLocalizedText;
  iconKind: string;
  iconRef: string;
  rarity: WheelRarity;
  amount: number;
  available: boolean;
  unavailable: SectorUnavailable | null;
}

export interface WheelView {
  enabled: boolean;
  sectors: WheelSector[];
  spinBalance: number;
  pointsBalance: number;
  freeSpin: { available: boolean; availableAt: string | null };
  spinPricePoints: number | null;
  canSpin: boolean;
}

/** What a spin gave, by kind. Absent keys mean "not this kind of prize". */
export interface WheelPrize {
  points?: number;
  days?: number;
  trafficGb?: number;
  discountPercent?: number;
  promoCode?: string;
  spins?: number;
  /** The Steam key itself — the winner's, and readable only in their history. */
  key?: string;
}

export interface WheelSpinResult {
  spun: boolean;
  /** WHEEL_DISABLED | WHEEL_UNAVAILABLE | NO_SPINS | USER_NOT_FOUND */
  reason?: string;
  spinId?: string;
  /** The sector the wheel stopped on, so the animation can land on it. */
  sectorId?: string | null;
  kind?: WheelSectorKind;
  amount?: number;
  status?: WheelSpinStatus;
  prize?: WheelPrize | null;
  spinBalance?: number;
  /** True when this request had already been served and is being replayed. */
  replayed?: boolean;
}

export interface WheelHistoryItem {
  spinId: string;
  kind: WheelSectorKind;
  title: WheelLocalizedText;
  rarity: WheelRarity;
  amount: number;
  status: WheelSpinStatus;
  createdAt: string;
  prize: WheelPrize | null;
  /** The conversation where a manual prize is being settled. */
  ticketId: string | null;
}

export interface WheelHistoryPage {
  items: WheelHistoryItem[];
  nextCursor: string | null;
}

export const getWheel = (): Promise<WheelView> =>
  apiClient.get<WheelView>("/wheel").then((r) => r.data);

export const getWheelHistory = (params: { cursor?: string | null; limit?: number } = {}):
  Promise<WheelHistoryPage> =>
  apiClient
    .get<WheelHistoryPage>("/wheel/history", {
      params: {
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      },
    })
    .then((r) => r.data);

/**
 * Spin once.
 *
 * The caller supplies the handle and MUST keep it across retries of one
 * intended spin — that is the whole mechanism: a second call with the same
 * handle is answered with the spin already taken instead of costing another.
 */
export const spinWheel = (idempotencyKey: string): Promise<WheelSpinResult> =>
  apiClient.post<WheelSpinResult>("/wheel/spin", { idempotencyKey }).then((r) => r.data);

export const buySpins = (
  count: number,
  idempotencyKey: string,
): Promise<{ spinBalance: number; pointsBalance: number }> =>
  apiClient
    .post<{ spinBalance: number; pointsBalance: number }>("/wheel/buy", { count, idempotencyKey })
    .then((r) => r.data);
