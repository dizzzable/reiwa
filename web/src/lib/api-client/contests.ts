/**
 * Contests namespace — events with a draw at the end, as the person entering
 * them sees them. Same-origin; the session cookie authenticates.
 */
import { apiClient } from "./transport.js";
import type { WheelLocalizedText, WheelPrize, WheelSectorKind, WheelSpinStatus } from "./wheel.js";

export type ContestStatus = "DRAFT" | "ACTIVE" | "DRAWN" | "CANCELLED";

/** Why the enter button is not there. */
export type ContestEntryRefusal =
  | "NOT_OPEN"
  | "NOT_STARTED"
  | "ENDED"
  | "NOT_ELIGIBLE"
  | "FULL"
  /** Telegram says the person is not in the contest's channel. */
  | "CHANNEL_REQUIRED"
  /** The contest needs a channel and the account has no Telegram to check. */
  | "NEEDS_TELEGRAM"
  /** A leaderboard: nothing to enter, everybody in the audience counts. */
  | "AUTOMATIC";

/** A draw among those who entered, or places by a metric. */
export type ContestKind = "DRAW" | "LEADERBOARD";

/** What a leaderboard ranks by. */
export type ContestMetric = "REFERRALS_PAID" | "PAYMENTS_SUM" | "TRAFFIC" | "POINTS_EARNED";

/** A leaderboard as this person sees it. Scores are in the metric's unit: friends, minor units, bytes, points. */
export interface ContestLeaderboardView {
  metric: ContestMetric | null;
  /** The base currency a payments score is in. */
  currency: string;
  minScore: number | null;
  top: Array<{ rank: number; name: string | null; score: number; me: boolean }>;
  total: number;
  mine: { rank: number; score: number } | null;
  /** How much more takes the last prize place: 0 holding one, null when it no longer matters. */
  toPrize: number | null;
}

export interface ContestPrizeView {
  place: number;
  /** The last place of a range — «4–10 место». Absent or null: one place. */
  placeTo?: number | null;
  kind: WheelSectorKind;
  title: WheelLocalizedText;
  amount: number;
}

export interface ContestView {
  id: string;
  title: WheelLocalizedText;
  description: WheelLocalizedText;
  status: ContestStatus;
  startAt: string;
  endAt: string;
  /** How many have entered — the one number that makes it feel real. */
  entries: number;
  prizes: ContestPrizeView[];
  entered: boolean;
  closed: ContestEntryRefusal | null;
  /** Absent from a panel older than leaderboards: a draw. */
  kind?: ContestKind;
  leaderboard?: ContestLeaderboardView | null;
  /** This person's own result once drawn. */
  myResult: {
    place: number;
    prizeTitle: WheelLocalizedText;
    status: WheelSpinStatus;
    prize: WheelPrize | null;
    ticketId: string | null;
    /** Waiting for the operator's check before it is paid. */
    held?: boolean;
    score?: number | null;
  } | null;
  /** The channel entering needs. Absent from a panel older than channels. */
  channel?: { joinUrl: string } | null;
  /** What earns extra chances, and how many this person holds. `null`: one each. */
  tickets?: { perPurchase: number; perReferral: number; max: number | null; mine: number } | null;
  /** SHA-256 of the draw key, promised from the start. */
  seedHash?: string | null;
  /** The draw key itself, once the draw has used it. */
  seed?: string | null;
  /** Who won a finished contest, names masked. */
  winners?: Array<{ place: number; name: string | null; prizeTitle: WheelLocalizedText; score?: number | null }> | null;
  drawnEntries?: number | null;
  drawnTickets?: number | null;
}

export interface ContestEntryAnswer {
  entered: boolean;
  reason: ContestEntryRefusal | null;
  /** With `CHANNEL_REQUIRED`: where to join. */
  joinUrl?: string;
}

export const getContests = (): Promise<ContestView[]> =>
  apiClient.get<ContestView[]>("/contests").then((r) => (Array.isArray(r.data) ? r.data : []));

export const enterContest = (contestId: string): Promise<ContestEntryAnswer> =>
  apiClient
    .post<ContestEntryAnswer>(`/contests/${encodeURIComponent(contestId)}/enter`)
    .then((r) => r.data);
