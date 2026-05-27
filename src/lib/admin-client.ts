/**
 * AdminClient — typed HTTP client for rezeis-admin internal API.
 *
 * All paths match the InternalApiController routes.
 * Auth: Bearer JWT in the Authorization header. The token is issued by
 * rezeis-admin's Settings → API Tokens UI (one named token per consumer
 * — reiwa, telegram-bot, monitor, etc.) and verified server-side by
 * `InternalAdminAuthGuard` against the `api_tokens` table. Optional
 * HMAC-SHA256 request signing is layered on top via
 * `REZEIS_INTERNAL_SHARED_SECRET`.
 *
 * Connection model:
 *   - One persistent undici `Pool` per upstream origin, created lazily on
 *     the first request and reused for the lifetime of the AdminClient.
 *   - HTTP/1.1 keep-alive with up to 50 concurrent connections per origin.
 *     Pipelining=1 keeps semantics identical to a regular fetch but lets
 *     undici reuse sockets aggressively, which roughly doubles throughput
 *     under high concurrency vs. the global `fetch` default.
 *   - Request timeouts default to 30s body / 10s headers — enough for
 *     slow upstream operations (image generation, payment provider
 *     round-trips) but short enough to fail fast on stalled sockets.
 *
 * Designed for the BFF flow `reiwa → rezeis-admin` over the shared Docker
 * network: a single AdminClient instance is created per process (api / bot
 * / worker) and shared across all routes.
 */

import { createHash, createHmac } from "node:crypto";
import { Pool } from "undici";

const DEFAULT_POOL_CONNECTIONS = 50;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 60_000;

export class AdminClient {
  private baseUrl: string;
  private origin: string;
  private basePath: string;
  private apiKey: string;
  private sharedSecret: string | null;
  private pool: Pool;

  constructor(baseUrl: string, apiKey: string, sharedSecret?: string | null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    // `Pool` is keyed by origin (scheme + host + port). Any path component on
    // baseUrl is preserved separately and prepended to every request path.
    this.origin = parsed.origin;
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.sharedSecret = sharedSecret ?? null;
    this.pool = new Pool(this.origin, {
      connections: DEFAULT_POOL_CONNECTIONS,
      pipelining: 1,
      keepAliveTimeout: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
      bodyTimeout: DEFAULT_BODY_TIMEOUT_MS,
    });
  }

  /**
   * Closes the pool gracefully. Call from a SIGTERM/SIGINT handler so in-flight
   * requests finish before the process exits.
   */
  async close(): Promise<void> {
    await this.pool.close();
  }

  private signRequest(method: string, path: string, timestamp: string, body?: unknown): string {
    const bodyStr = body ? JSON.stringify(body) : "";
    const bodyHash = createHash("sha256").update(bodyStr).digest("hex");
    const message = [method.toUpperCase(), path, timestamp, bodyHash].join("\n");
    return createHmac("sha256", this.sharedSecret!).update(message).digest("hex");
  }

  /**
   * Opens a streaming GET against an upstream endpoint and returns the
   * raw response body as a Node `Readable`. Used for SSE proxying so
   * reiwa can `.pipe()` the stream straight back to the browser without
   * buffering the whole body.
   *
   * Returns `null` when the upstream rejects the connection (4xx/5xx).
   */
  async openStream(
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: NodeJS.ReadableStream } | null> {
    const fullPath = `${this.basePath}${path}`;
    const signingHeaders: Record<string, string> = {};
    if (this.sharedSecret) {
      const timestamp = Date.now().toString();
      signingHeaders["x-request-timestamp"] = timestamp;
      signingHeaders["x-request-signature"] = this.signRequest("GET", path, timestamp);
    }
    // SSE responses don't have a meaningful Content-Length and stream
    // for as long as the user keeps the tab open. Disable the body
    // timeout entirely so undici doesn't yank the socket.
    const response = await this.pool.request({
      method: "GET",
      path: fullPath,
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Authorization: `Bearer ${this.apiKey}`,
        ...signingHeaders,
        ...extraHeaders,
      },
      bodyTimeout: 0,
      headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    });
    if (response.statusCode >= 400) {
      // Drain the body so the socket is returned to the pool.
      await response.body.text().catch(() => undefined);
      return null;
    }
    return { status: response.statusCode, body: response.body };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const signingHeaders: Record<string, string> = {};
    if (this.sharedSecret) {
      const timestamp = Date.now().toString();
      signingHeaders["x-request-timestamp"] = timestamp;
      // Sign the original logical path (excluding any base-path prefix) so
      // upstream verification logic stays the same as with the legacy fetch().
      signingHeaders["x-request-signature"] = this.signRequest(method, path, timestamp, body);
    }

    const response = await this.pool.request({
      method: method.toUpperCase() as
        | "GET"
        | "POST"
        | "PUT"
        | "PATCH"
        | "DELETE"
        | "HEAD"
        | "OPTIONS",
      path: fullPath,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...signingHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text().catch(() => "Unknown error");
      throw new Error(`AdminClient: ${method} ${path} → ${response.statusCode}: ${text}`);
    }

    // 204 No Content / empty response handling — return null cast to T so
    // callers that don't expect a body don't trip JSON.parse on "".
    const raw = await response.body.text();
    if (raw.length === 0) {
      return null as unknown as T;
    }
    return JSON.parse(raw) as T;
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  test() { return this.request("GET", "/api/internal/test"); }

  // ── Platform ────────────────────────────────────────────────────────────────
  getPlatformPolicy() { return this.request("GET", "/api/internal/settings/platform-policy"); }

  // ── Catalog ─────────────────────────────────────────────────────────────────
  getPublicPlans() { return this.request("GET", "/api/internal/catalog/plans"); }

  // ── User session ─────────────────────────────────────────────────────────────
  /**
   * Bootstraps (creates / updates) a user by Telegram identity. Called by
   * the bot on `/start` to make sure the user exists before any other
   * internal call references it. Returns the canonical user-session
   * payload, identical in shape to `getUserSession`.
   */
  bootstrapUser(data: { telegramId: string; username?: string; name: string; language?: string }) {
    return this.request("POST", "/api/internal/user/bootstrap", data);
  }

  getUserSession(telegramId: string) {
    return this.request("GET", `/api/internal/user/session?telegramId=${encodeURIComponent(telegramId)}`);
  }

  updateUserLanguage(telegramId: string, language: string) {
    return this.request("PATCH", "/api/internal/user/language", { telegramId, language });
  }

  // ── Subscription ─────────────────────────────────────────────────────────────
  getUserSubscription(telegramId: string) {
    return this.request("GET", `/api/internal/user/subscription?telegramId=${encodeURIComponent(telegramId)}`);
  }

  getAllUserSubscriptions(telegramId: string) {
    return this.request("GET", `/api/internal/user/subscriptions?telegramId=${encodeURIComponent(telegramId)}`);
  }

  // ── Trial ────────────────────────────────────────────────────────────────────
  getTrialEligibility(telegramId: string) {
    return this.request("GET", `/api/internal/user/trial/eligibility?telegramId=${encodeURIComponent(telegramId)}`);
  }

  activateTrial(telegramId: string) {
    return this.request("POST", "/api/internal/user/trial", { telegramId });
  }

  // ── Quote ────────────────────────────────────────────────────────────────────
  getQuote(telegramId: string, planId: number, durationDays: number, gatewayType: string) {
    return this.request("POST", "/api/internal/subscriptions/quote", { telegramId, planId, durationDays, gatewayType });
  }

  // ── Payments ─────────────────────────────────────────────────────────────────
  getEnabledGateways() { return this.request("GET", "/api/internal/payments/gateways"); }

  createCheckout(
    telegramId: string,
    planId: number,
    durationDays: number,
    gatewayType: string,
    successUrl?: string | null,
    failUrl?: string | null,
  ) {
    const payload: Record<string, unknown> = {
      telegramId,
      planId,
      durationDays,
      gatewayType,
    };
    if (successUrl) payload["successUrl"] = successUrl;
    if (failUrl) payload["failUrl"] = failUrl;
    return this.request("POST", "/api/internal/payments/checkout", payload);
  }

  getPaymentStatus(paymentId: string) {
    return this.request("GET", `/api/internal/payments/${paymentId}`);
  }

  // ── Devices ──────────────────────────────────────────────────────────────────
  /**
   * The upstream `InternalUserDevicesController` works off the rezeis-admin
   * `User.id` (CUID). Reiwa keeps `telegramId` everywhere on the wire and
   * we translate via the `?telegramId=` query so callers don't have to
   * resolve the user themselves.
   */
  getUserDevices(telegramId: string) {
    return this.request("GET", `/api/internal/user/devices?telegramId=${encodeURIComponent(telegramId)}`);
  }

  deleteUserDevice(telegramId: string, hwid: string) {
    return this.request(
      "DELETE",
      `/api/internal/user/devices/${encodeURIComponent(hwid)}?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  // ── Activity ─────────────────────────────────────────────────────────────────
  getTransactions(telegramId: string) {
    return this.request("GET", `/api/internal/user/transactions?telegramId=${encodeURIComponent(telegramId)}`);
  }

  getNotifications(telegramId: string) {
    return this.request("GET", `/api/internal/user/notifications?telegramId=${encodeURIComponent(telegramId)}`);
  }

  getUnreadCount(telegramId: string) {
    return this.request(
      "GET",
      `/api/internal/user/notifications/unread-count?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  markAllNotificationsRead(telegramId: string) {
    return this.request("POST", "/api/internal/user/notifications/read-all", { telegramId });
  }

  // ── Promocodes ───────────────────────────────────────────────────────────────
  /**
   * Activate a promocode on behalf of a Telegram user. The upstream
   * controller resolves the rezeis-admin user from `telegramId` and runs
   * the activation pipeline.
   */
  activatePromocode(telegramId: string, code: string) {
    return this.request("POST", "/api/internal/promocodes/activate-by-telegram", {
      telegramId,
      code,
    });
  }

  // ── Referrals ────────────────────────────────────────────────────────────────
  getReferralSummary(telegramId: string) {
    return this.request("GET", `/api/internal/user/${telegramId}/referrals/summary`);
  }

  createReferralInvite(telegramId: string) {
    return this.request("POST", `/api/internal/user/${telegramId}/referrals/invite`, {});
  }

  getReferralRewards(telegramId: string) {
    return this.request("GET", `/api/internal/user/${telegramId}/referrals/rewards`);
  }

  // ── Partner ──────────────────────────────────────────────────────────────────
  getPartnerInfo(telegramId: string) {
    return this.request("GET", `/api/internal/user/${telegramId}/partner/info`);
  }

  /**
   * Lightweight partner-status check used by the reiwa bottom-nav to decide
   * between rendering the Referral or the Partner tab. The endpoint avoids
   * heavy joins (earnings/withdrawals) and is safe to call on every dashboard
   * mount.
   */
  getPartnerStatus(telegramId: string) {
    return this.request<{ isActive: boolean }>(
      "GET",
      `/api/internal/user/partner-status?telegramId=${encodeURIComponent(telegramId)}`,
    );
  }

  getPartnerEarnings(telegramId: string) {
    return this.request("GET", `/api/internal/user/${telegramId}/partner/earnings`);
  }

  getPartnerWithdrawals(telegramId: string) {
    return this.request("GET", `/api/internal/user/${telegramId}/partner/withdrawals`);
  }

  createWithdrawal(telegramId: string, data: { amount: number; method: string; requisites: string }) {
    return this.request("POST", `/api/internal/user/${telegramId}/partner/withdraw`, data);
  }

  // ── Bot config ───────────────────────────────────────────────────────────────
  getBotConfig() { return this.request("GET", "/api/internal/bot-config"); }
  /**
   * @deprecated Was incorrectly aliased to `bot-config`. The actual public
   * branding+locale payload lives under `getReiwaPublicConfig()`. Kept only
   * so the SPA build doesn't break during the rename.
   */
  getPublicConfig() { return this.request("GET", "/api/internal/branding/public-config"); }

  // ── Branding & Public Config (typed) ─────────────────────────────────────────
  /**
   * Returns just the typed branding payload (colours, gradients, effects, fonts).
   * Used by surfaces that don't need locale settings (payment-return splash,
   * bot-side renderers).
   */
  getBranding() {
    return this.request<{
      brandName: string;
      logoUrl: string | null;
      primary: string;
      primaryFg: string;
      bgPrimary: string;
      bgSecondary: string;
      cardGradient: string;
      cardPattern: string | null;
      bgEffect: 'NONE' | 'MESH' | 'PARTICLES' | 'NOISE' | 'AURORA';
      borderRadius: string;
      fontFamily: string;
    }>("GET", "/api/internal/branding");
  }

  /**
   * Returns the full SPA bootstrap payload — branding + locale defaults
   * derived from rezeis-admin's `.env` (`REZEIS_LOCALES` / `REZEIS_DEFAULT_LOCALE`).
   * Reiwa SPA hits this on the very first render.
   */
  getReiwaPublicConfig() {
    return this.request<{
      branding: {
        brandName: string;
        logoUrl: string | null;
        primary: string;
        primaryFg: string;
        bgPrimary: string;
        bgSecondary: string;
        cardGradient: string;
        cardPattern: string | null;
        bgEffect: 'NONE' | 'MESH' | 'PARTICLES' | 'NOISE' | 'AURORA';
        borderRadius: string;
        fontFamily: string;
      };
      locales: readonly string[];
      defaultLocale: string;
    }>("GET", "/api/internal/branding/public-config");
  }

  // ── Web account session-side flows (deprecated; new web-auth replaces them) ──
  /**
   * @deprecated Routed via the new `/api/internal/web-auth/login` endpoint —
   * the older `web-account/sign-in` path is kept here only to avoid breaking
   * SPA bundles that haven't been rebuilt yet. New callers must use
   * `webAuthLogin(...)` instead.
   */
  signInWebAccount(login: string, password: string) {
    return this.request("POST", "/api/internal/user/web-account/sign-in", { login, password });
  }

  /**
   * @deprecated Use `webAuthRecover(login)` — the new endpoint handles both
   * email and Telegram challenge issuance. This wrapper is kept in place so
   * old SPA chunks served from the PWA cache keep working until the next
   * service-worker refresh.
   */
  initiatePasswordRecovery(email: string) {
    return this.request("POST", "/api/internal/web-auth/recover", { username: email });
  }

  /**
   * @deprecated A password-reset-by-link flow is not exposed by the new
   * web-auth contract — the SPA collects the email-verification challenge
   * code from the user and calls `webAuthChangePassword`. Kept as a 410-style
   * stub so the SPA bundle compiles, but the upstream returns `404` when hit.
   */
  resetPasswordByLink(tokenHash: string, newPasswordHash: string) {
    return this.request("POST", "/api/internal/web-auth/change-password", {
      currentPasswordHash: tokenHash,
      newPasswordHash,
    });
  }

  // ── Web Auth (new internal endpoints) ─────────────────────────────────────────

  webAuthRegister(login: string, password: string, options?: { email?: string; telegramIdToLink?: string }) {
    return this.request<{ userId: string; webAccountId: string }>(
      "POST",
      "/api/internal/web-auth/register",
      {
        login,
        password,
        email: options?.email,
        telegramIdToLink: options?.telegramIdToLink,
      },
    );
  }

  webAuthLogin(login: string, password: string) {
    return this.request<{
      userId: string;
      requiresPasswordChange: boolean;
      telegramLinked: boolean;
      emailVerified: boolean;
    }>("POST", "/api/internal/web-auth/login", { login, password });
  }

  webAuthRecover(login: string) {
    return this.request<{ method: "telegram" | "email" | "none"; challengeId?: string }>(
      "POST",
      "/api/internal/web-auth/recover",
      { login },
    );
  }

  webAuthChangePassword(userId: string, currentPassword: string, newPassword: string) {
    return this.request<{ success: boolean }>(
      "POST",
      "/api/internal/web-auth/change-password",
      { userId, currentPassword, newPassword },
    );
  }

  getRegistrationToggle() {
    return this.request<{ enabled: boolean }>(
      "GET",
      "/api/internal/settings/registration-toggle",
    );
  }

  acceptRules(telegramId: string) {
    return this.request("PATCH", `/api/internal/user/session/rules-acceptance?telegramId=${encodeURIComponent(telegramId)}`, {});
  }

  changeWebAccountPassword(telegramId: string, newPassword: string) {
    return this.request("PATCH", "/api/internal/user/session/web-account-password", { userId: telegramId, password: newPassword });
  }

  snoozeWebAccountLinkPrompt(telegramId: string) {
    return this.request("PATCH", `/api/internal/user/session/web-account-link-prompt-snooze?telegramId=${encodeURIComponent(telegramId)}`, {});
  }

  issueEmailVerificationChallenge(telegramId: string, _email: string) {
    return this.request("PATCH", "/api/internal/user/session/web-account-email-verification-challenge", { userId: telegramId });
  }

  completeEmailVerification(telegramId: string, code: string) {
    return this.request("PATCH", "/api/internal/user/session/web-account-email-verification-completion", { userId: telegramId, code });
  }

  // ── Linking ────────────────────────────────────────────────────────────────────

  linkTelegramGenerate(userId: string) {
    return this.request<{ code: string; expiresAt: string }>(
      "POST",
      "/api/internal/link/telegram/generate",
      { userId },
    );
  }

  /**
   * Called by the reiwa bot when an incoming Telegram user submits a
   * linking code (`/start <code>` or `/link <code>`). Either attaches
   * Telegram to the existing reiwa_id behind the code, or returns a
   * structured failure (`INVALID_OR_EXPIRED_CODE`,
   * `TELEGRAM_ALREADY_LINKED`) the bot can render to the user.
   */
  linkTelegramConsume(telegramId: string, code: string) {
    return this.request<{ success: boolean; reason?: string; userId?: string }>(
      "POST",
      "/api/internal/link/telegram/consume",
      { telegramId, code },
    );
  }

  linkEmailInitiate(userId: string, email: string) {
    return this.request<{ success: boolean; message: string }>(
      "POST",
      "/api/internal/link/email/initiate",
      { userId, email },
    );
  }

  linkEmailVerify(userId: string, code: string) {
    return this.request<{ success: boolean; verified: boolean }>(
      "POST",
      "/api/internal/link/email/verify",
      { userId, code },
    );
  }

  // ── Push Notifications ────────────────────────────────────────────────────────

  pushSubscribe(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.request<{ success: boolean }>(
      "POST",
      "/api/internal/push/subscribe",
      { userId, subscription },
    );
  }

  pushUnsubscribe(userId: string, endpoint: string) {
    return this.request<{ success: boolean }>(
      "DELETE",
      "/api/internal/push/unsubscribe",
      { userId, endpoint },
    );
  }

  // ── Notification single read ──────────────────────────────────────────────────
  markNotificationRead(telegramId: string, notificationId: string) {
    return this.request(
      "POST",
      `/api/internal/user/notifications/${encodeURIComponent(notificationId)}/read`,
      { telegramId },
    );
  }

  // ── Payment webhook forward ───────────────────────────────────────────────────
  forwardWebhook(gatewayType: string, rawPayload: unknown) {
    return this.request("POST", `/api/internal/payments/webhooks/${gatewayType}`, rawPayload);
  }

  // ── Action policy ─────────────────────────────────────────────────────────────
  getActionPolicy(telegramId: string, planId?: number) {
    return this.request("POST", "/api/internal/subscriptions/action-policy", { telegramId, planId });
  }

  // ── Promo extended ────────────────────────────────────────────────────────────
  getPromoActivations(telegramId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return this.request(
      "GET",
      `/api/internal/promocodes/user/${telegramId}/activations?limit=${limit}&offset=${offset}`,
    );
  }

  getEligibleSubscriptions(userId: string, code: string) {
    return this.request(
      "POST",
      `/api/internal/promocodes/eligible-subscriptions?userId=${encodeURIComponent(userId)}&code=${encodeURIComponent(code)}`,
      {},
    );
  }

  // ── Referral extended ─────────────────────────────────────────────────────────
  getReferralInvites(telegramId: string) {
    return this.request("GET", `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/invite-capacity`);
  }

  revokeReferralInvite(telegramId: string, inviteId: string) {
    return this.request(
      "POST",
      `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/invites/${encodeURIComponent(inviteId)}/revoke`,
      {},
    );
  }

  exchangePointsForGiftPromocode(telegramId: string, data: { points: number }) {
    return this.request(
      "POST",
      `/api/internal/user/${encodeURIComponent(telegramId)}/referrals/exchange`,
      { type: 'GIFT_PROMOCODE', points: data.points },
    );
  }

  // ── Worker ────────────────────────────────────────────────────────────────────
  getExpiryAlerts() { return this.request("GET", "/api/internal/worker/expiry-alerts"); }
}
