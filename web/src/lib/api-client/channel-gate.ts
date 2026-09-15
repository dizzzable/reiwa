/**
 * Channel-gate namespace — «Канал обязателен», asked from the Telegram Mini App.
 *
 * `GET /channel-gate` answers from whatever the server already knows;
 * `POST /channel-gate/check` always asks Telegram, and is what «✅ Я подписался»
 * and the automatic re-check after a return to the Mini App send. Both answer
 * the same shape. Credentials and CSRF are the transport's, as for every other
 * call: the session cookie rides `withCredentials`, and the CSRF guard in
 * `src/api/middleware/csrf-protection.ts` reads the `Origin` header the browser
 * attaches to a same-origin POST — there is no token to add.
 *
 * The answer is re-read here rather than cast. A status this build does not
 * recognise — an API one release ahead, a proxy's error page with a 200 — reads
 * as `unverified`, which lets the user in: only a real `not-subscribed` blocks.
 */
import { apiClient } from "./transport.js";

export type ChannelGateStatus = "off" | "subscribed" | "not-subscribed" | "unverified";

export interface ChannelGateAnswer {
  readonly status: ChannelGateStatus;
  /** Where «📢 Перейти в канал» goes; `null` when there is nothing to open. */
  readonly joinUrl: string | null;
}

const STATUSES: readonly ChannelGateStatus[] = ["off", "subscribed", "not-subscribed", "unverified"];

/**
 * The only schemes a join link is opened with: http and https.
 *
 * Not `tg:`, although «Ссылка на канал» may be typed that way. Every way the
 * button has out goes through `openExternalUrl`, and none of them opens one:
 * with the SDK, `openTelegramLink` and `openLink` both throw on a scheme that is
 * not http(s) and the helper then returns without opening anything
 * (`lib/utils.ts`), so the button silently does nothing; without the SDK it
 * reaches `window.open`, which Telegram for Android loads in a web view of its
 * own and turns into an error page. The server normalises `tg://resolve` and
 * `tg://join` to `https://t.me/…`, so a link that still arrives with another
 * scheme is dropped and the button is simply not offered.
 *
 * And never `javascript:`, `data:`, `vbscript:`, `file:` or `intent:`: the value
 * comes from an API response and ends in `window.open`, which is the same
 * reasoning as the one-scheme allowlist in `startCheckoutRedirect`.
 */
const JOIN_URL_SCHEMES: readonly string[] = ["https:", "http:"];

function readJoinUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return JOIN_URL_SCHEMES.includes(parsed.protocol) ? value : null;
}

/** The wire answer, re-read so that nothing but a real `not-subscribed` blocks. */
export function readChannelGateAnswer(raw: unknown): ChannelGateAnswer {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = STATUSES.find((known) => known === body.status) ?? "unverified";
  return { status, joinUrl: readJoinUrl(body.joinUrl) };
}

/** Why a call failed, in the terms the gate acts on. */
export type ChannelGateFailure =
  /** 401 — the session is gone. */
  | { readonly kind: "unauthorized" }
  /** 429 — asked too often; `retryAfterSeconds` is how long to hold back. */
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  /** Anything else: a 5xx, a dropped connection, a request abandoned on its budget. */
  | { readonly kind: "other" };

/**
 * What a 429 is waited out for when it says nothing: the same fallback the
 * Mini App's sign-in screen uses for its own 429 (`tma-bootstrap-page.tsx`).
 */
export const CHANNEL_GATE_RETRY_AFTER_FALLBACK_SECONDS = 60;

function positiveWholeSeconds(value: unknown): number | null {
  const seconds = typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * `retryAfter` from the body, then the `Retry-After` header — both whole seconds
 * from this API (`createGenericLimitHandler` in `src/api/middleware/rate-limit.ts`)
 * — then the fallback. The header is read through `AxiosHeaders#get` when the
 * response carries one, which ignores case; a plain object is read lower-case,
 * which is how XHR hands header names over.
 */
function readRetryAfterSeconds(response: { readonly data?: unknown; readonly headers?: unknown }): number {
  const body = response.data;
  const fromBody =
    typeof body === "object" && body !== null ? positiveWholeSeconds((body as Record<string, unknown>).retryAfter) : null;
  if (fromBody !== null) return fromBody;
  const headers = response.headers as { get?: (name: string) => unknown; [name: string]: unknown } | undefined;
  const header = typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
  return positiveWholeSeconds(header) ?? CHANNEL_GATE_RETRY_AFTER_FALLBACK_SECONDS;
}

/** Classifies a rejection from `getChannelGate` or `checkChannelGate`. */
export function readChannelGateFailure(error: unknown): ChannelGateFailure {
  const response =
    typeof error === "object" && error !== null
      ? (error as { response?: { status?: unknown; data?: unknown; headers?: unknown } }).response
      : undefined;
  if (response?.status === 401) return { kind: "unauthorized" };
  if (response?.status === 429) return { kind: "rate-limited", retryAfterSeconds: readRetryAfterSeconds(response) };
  return { kind: "other" };
}

interface RequestOptions {
  /** Lets the caller abandon a request it has stopped waiting for. */
  readonly signal?: AbortSignal;
}

const withSignal = (options: RequestOptions) =>
  options.signal === undefined ? undefined : { signal: options.signal };

/** The gate's answer for this session. */
export const getChannelGate = (options: RequestOptions = {}) =>
  apiClient.get<unknown>("/channel-gate", withSignal(options)).then((r) => readChannelGateAnswer(r.data));

/** Asks Telegram again. The body is an empty JSON object on purpose. */
export const checkChannelGate = (options: RequestOptions = {}) =>
  apiClient
    .post<unknown>("/channel-gate/check", {}, withSignal(options))
    .then((r) => readChannelGateAnswer(r.data));
