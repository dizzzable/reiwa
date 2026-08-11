import { apiClient } from "./transport.js";

export interface OlcrtcSubscriptionPayload {
  enabled: boolean;
  eligible: boolean;
  status: "DISABLED" | "NO_ACTIVE_SUBSCRIPTION" | "UNAVAILABLE" | "READY" | string;
  reason?: string;
  subscription: {
    sessionId: string;
    subscriptionId: string;
    profileId: string;
    provider: string;
    transport: string;
    url: string;
    refreshSeconds: number;
    expiresAt: string | null;
  } | null;
}

export const getOlcrtcSubscription = () =>
  apiClient
    .get<OlcrtcSubscriptionPayload>("/olcrtc/subscription")
    .then((r) => r.data);

export const provisionOlcrtcSubscription = () =>
  apiClient
    .post<OlcrtcSubscriptionPayload>("/olcrtc/subscription/provision")
    .then((r) => r.data);
