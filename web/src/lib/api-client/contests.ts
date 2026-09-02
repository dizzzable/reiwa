/**
 * Contests namespace — events with a draw at the end, as the person entering
 * them sees them. Same-origin; the session cookie authenticates.
 */
import { apiClient } from "./transport.js";
import type { WheelLocalizedText, WheelPrize, WheelSectorKind, WheelSpinStatus } from "./wheel.js";

export type ContestStatus = "DRAFT" | "ACTIVE" | "DRAWN" | "CANCELLED";

/** Why the enter button is not there. */
export type ContestEntryRefusal = "NOT_OPEN" | "NOT_STARTED" | "ENDED" | "NOT_ELIGIBLE" | "FULL";

export interface ContestPrizeView {
  place: number;
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
  /** This person's own result once drawn. Nobody else's. */
  myResult: {
    place: number;
    prizeTitle: WheelLocalizedText;
    status: WheelSpinStatus;
    prize: WheelPrize | null;
    ticketId: string | null;
  } | null;
}

export const getContests = (): Promise<ContestView[]> =>
  apiClient.get<ContestView[]>("/contests").then((r) => (Array.isArray(r.data) ? r.data : []));

export const enterContest = (
  contestId: string,
): Promise<{ entered: boolean; reason: ContestEntryRefusal | null }> =>
  apiClient
    .post<{ entered: boolean; reason: ContestEntryRefusal | null }>(
      `/contests/${encodeURIComponent(contestId)}/enter`,
    )
    .then((r) => r.data);
