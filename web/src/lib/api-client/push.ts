/**
 * Web-push namespace — VAPID public key + subscribe / unsubscribe.
 *
 * The SPA caller should always go through `lib/push.ts` rather than
 * these primitives directly — that wrapper handles permission
 * negotiation, base64 conversion, and PushManager subscription on
 * top of these endpoints.
 */
import { apiClient } from "./transport.js";

export interface PushPublicKeyResponse {
  readonly publicKey: string;
}

export interface PushSubscribePayload {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly userAgent?: string;
}

export interface PushUnsubscribePayload {
  readonly endpoint: string;
}

export const getPushPublicKey = () =>
  apiClient.get<PushPublicKeyResponse>("/push/public-key").then((r) => r.data);

export const pushSubscribe = (payload: PushSubscribePayload) =>
  apiClient.post<{ success: boolean }>("/push/subscribe", payload).then((r) => r.data);

export const pushUnsubscribe = (payload: PushUnsubscribePayload) =>
  apiClient.post<{ success: boolean }>("/push/unsubscribe", payload).then((r) => r.data);
