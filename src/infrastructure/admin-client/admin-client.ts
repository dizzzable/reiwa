/**
 * AdminClient — typed namespace facade for the rezeis-admin internal API.
 *
 * Wave 2 split the legacy 62-method god-class into 14 namespaces grouped
 * by upstream domain. Use the namespace surface for new code:
 *
 *   const client = new AdminClient(baseUrl, apiKey);
 *   await client.user.bootstrap({ telegramId, name });
 *   await client.payments.getEnabledGateways();
 *
 * Each namespace owns one slice of the upstream API. The transport
 * (undici Pool, HMAC signing) is shared across them all via the
 * `AdminTransport` instance held by the facade.
 *
 * Back-compat: every method from the pre-Wave-2 god-class is kept on
 * this facade as a thin delegate, so `bot/main.ts`, `worker/main.ts`,
 * `api/routes/*` and `event-reporter.ts` keep compiling untouched.
 * Wave 3-5 migrate call sites to the namespace surface; the legacy
 * methods are then removed in Wave 6.
 */
import type {
  BootstrapUserInput,
  BrandingPayload,
  CreateCheckoutOptions,
  CreateWithdrawalInput,
  ExchangePointsInput,
  LinkEmailInitiateResult,
  LinkEmailVerifyResult,
  LinkTelegramConsumeResult,
  LinkTelegramGenerateResult,
  PublicConfigPayload,
  WebAuthLoginResult,
  WebAuthRecoverResult,
  WebAuthRegisterOptions,
  WebAuthRegisterResult,
  WebPushSubscriptionPayload,
} from './namespaces/index.js';
import {
  ActivityNamespace,
  BrandingNamespace,
  CatalogNamespace,
  DevicesNamespace,
  EventsNamespace,
  LinkingNamespace,
  PartnerNamespace,
  PaymentsNamespace,
  PromocodesNamespace,
  PushNamespace,
  ReferralsNamespace,
  SubscriptionNamespace,
  SystemNamespace,
  TrialNamespace,
  UserNamespace,
  WebAuthNamespace,
} from './namespaces/index.js';
import { AdminTransport } from './transport.js';

export class AdminClient {
  private readonly transport: AdminTransport;

  // 14 namespaces composed onto the facade.
  readonly system: SystemNamespace;
  readonly catalog: CatalogNamespace;
  readonly user: UserNamespace;
  readonly subscription: SubscriptionNamespace;
  readonly trial: TrialNamespace;
  readonly payments: PaymentsNamespace;
  readonly devices: DevicesNamespace;
  readonly activity: ActivityNamespace;
  readonly promocodes: PromocodesNamespace;
  readonly referrals: ReferralsNamespace;
  readonly partner: PartnerNamespace;
  readonly branding: BrandingNamespace;
  readonly webAuth: WebAuthNamespace;
  readonly linking: LinkingNamespace;
  readonly push: PushNamespace;
  readonly events: EventsNamespace;

  constructor(baseUrl: string, apiKey: string, sharedSecret?: string | null) {
    this.transport = new AdminTransport({ baseUrl, apiKey, sharedSecret });
    this.system = new SystemNamespace(this.transport);
    this.catalog = new CatalogNamespace(this.transport);
    this.user = new UserNamespace(this.transport);
    this.subscription = new SubscriptionNamespace(this.transport);
    this.trial = new TrialNamespace(this.transport);
    this.payments = new PaymentsNamespace(this.transport);
    this.devices = new DevicesNamespace(this.transport);
    this.activity = new ActivityNamespace(this.transport);
    this.promocodes = new PromocodesNamespace(this.transport);
    this.referrals = new ReferralsNamespace(this.transport);
    this.partner = new PartnerNamespace(this.transport);
    this.branding = new BrandingNamespace(this.transport);
    this.webAuth = new WebAuthNamespace(this.transport);
    this.linking = new LinkingNamespace(this.transport);
    this.push = new PushNamespace(this.transport);
    this.events = new EventsNamespace(this.transport);
  }

  /**
   * Closes the underlying connection pool. Call from a SIGTERM/SIGINT
   * handler so in-flight requests finish before the process exits.
   */
  async close(): Promise<void> {
    await this.transport.close();
  }

  /**
   * Generic typed request escape hatch. New code should depend on the
   * namespace methods; this is kept exposed for the rare consumer
   * (notably `event-reporter.ts`) that wraps its own thin call.
   */
  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.transport.request<T>(method, path, body);
  }

  /**
   * Streaming GET helper used by the realtime SSE proxy. Returns the
   * raw upstream `Readable` so the API route can `.pipe()` it back to
   * the browser without buffering.
   */
  openStream(
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: NodeJS.ReadableStream } | null> {
    return this.transport.openStream(path, extraHeaders);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Legacy method surface (delegates to the namespaces above).
  //
  // Migrated by Wave 3-5; removed in Wave 6.
  // ────────────────────────────────────────────────────────────────────────────

  // ── Health ──────────────────────────────────────────────────────────────────
  test() { return this.system.test(); }

  // ── Platform ────────────────────────────────────────────────────────────────
  getPlatformPolicy() { return this.system.getPlatformPolicy(); }
  getRegistrationToggle() { return this.system.getRegistrationToggle(); }

  // ── Catalog ─────────────────────────────────────────────────────────────────
  getPublicPlans() { return this.catalog.getPublicPlans(); }

  // ── User session ────────────────────────────────────────────────────────────
  bootstrapUser(data: BootstrapUserInput) { return this.user.bootstrap(data); }
  getUserSession(telegramId: string) { return this.user.getSession(telegramId); }
  updateUserLanguage(telegramId: string, language: string) {
    return this.user.updateLanguage(telegramId, language);
  }
  acceptRules(telegramId: string) { return this.user.acceptRules(telegramId); }
  changeWebAccountPassword(telegramId: string, newPassword: string) {
    return this.user.changeWebAccountPassword(telegramId, newPassword);
  }
  snoozeWebAccountLinkPrompt(telegramId: string) {
    return this.user.snoozeWebAccountLinkPrompt(telegramId);
  }
  issueEmailVerificationChallenge(telegramId: string, email: string) {
    return this.user.issueEmailVerificationChallenge(telegramId, email);
  }
  completeEmailVerification(telegramId: string, code: string) {
    return this.user.completeEmailVerification(telegramId, code);
  }

  // ── Subscription ────────────────────────────────────────────────────────────
  getUserSubscription(telegramId: string) { return this.subscription.getActive(telegramId); }
  getAllUserSubscriptions(telegramId: string) { return this.subscription.getAll(telegramId); }
  getQuote(telegramId: string, planId: number, durationDays: number, gatewayType: string) {
    return this.subscription.getQuote(telegramId, planId, durationDays, gatewayType);
  }
  getActionPolicy(telegramId: string, planId?: number) {
    return this.subscription.getActionPolicy(telegramId, planId);
  }

  // ── Trial ───────────────────────────────────────────────────────────────────
  getTrialEligibility(telegramId: string) { return this.trial.getEligibility(telegramId); }
  activateTrial(telegramId: string) { return this.trial.activate(telegramId); }

  // ── Payments ────────────────────────────────────────────────────────────────
  getEnabledGateways() { return this.payments.getEnabledGateways(); }
  createCheckout(
    telegramId: string,
    planId: number,
    durationDays: number,
    gatewayType: string,
    successUrl?: string | null,
    failUrl?: string | null,
  ) {
    const options: CreateCheckoutOptions = { successUrl, failUrl };
    return this.payments.createCheckout(telegramId, planId, durationDays, gatewayType, options);
  }
  getPaymentStatus(paymentId: string) { return this.payments.getStatus(paymentId); }
  forwardWebhook(gatewayType: string, rawPayload: unknown) {
    return this.payments.forwardWebhook(gatewayType, rawPayload);
  }

  // ── Devices ─────────────────────────────────────────────────────────────────
  getUserDevices(telegramId: string) { return this.devices.list(telegramId); }
  deleteUserDevice(telegramId: string, hwid: string) {
    return this.devices.delete(telegramId, hwid);
  }

  // ── Activity ────────────────────────────────────────────────────────────────
  getTransactions(telegramId: string) { return this.activity.getTransactions(telegramId); }
  getNotifications(telegramId: string) { return this.activity.getNotifications(telegramId); }
  getUnreadCount(telegramId: string) { return this.activity.getUnreadCount(telegramId); }
  markAllNotificationsRead(telegramId: string) { return this.activity.markAllRead(telegramId); }
  markNotificationRead(telegramId: string, notificationId: string) {
    return this.activity.markRead(telegramId, notificationId);
  }

  // ── Promocodes ──────────────────────────────────────────────────────────────
  activatePromocode(telegramId: string, code: string) {
    return this.promocodes.activate(telegramId, code);
  }
  getPromoActivations(telegramId: string, page = 1, limit = 20) {
    return this.promocodes.getActivations(telegramId, page, limit);
  }
  getEligibleSubscriptions(userId: string, code: string) {
    return this.promocodes.getEligibleSubscriptions(userId, code);
  }

  // ── Referrals ───────────────────────────────────────────────────────────────
  getReferralSummary(telegramId: string) { return this.referrals.getSummary(telegramId); }
  createReferralInvite(telegramId: string) { return this.referrals.createInvite(telegramId); }
  getReferralRewards(telegramId: string) { return this.referrals.getRewards(telegramId); }
  getReferralInvites(telegramId: string) { return this.referrals.getInviteCapacity(telegramId); }
  revokeReferralInvite(telegramId: string, inviteId: string) {
    return this.referrals.revokeInvite(telegramId, inviteId);
  }
  exchangePointsForGiftPromocode(telegramId: string, data: ExchangePointsInput) {
    return this.referrals.exchangePointsForGiftPromocode(telegramId, data);
  }

  // ── Partner ─────────────────────────────────────────────────────────────────
  getPartnerInfo(telegramId: string) { return this.partner.getInfo(telegramId); }
  getPartnerStatus(telegramId: string) { return this.partner.getStatus(telegramId); }
  getPartnerEarnings(telegramId: string) { return this.partner.getEarnings(telegramId); }
  getPartnerWithdrawals(telegramId: string) { return this.partner.getWithdrawals(telegramId); }
  createWithdrawal(telegramId: string, data: CreateWithdrawalInput) {
    return this.partner.createWithdrawal(telegramId, data);
  }

  // ── Branding & bot config ───────────────────────────────────────────────────
  getBotConfig() { return this.branding.getBotConfig(); }
  /** @deprecated Was incorrectly aliased to `bot-config`. */
  getPublicConfig() { return this.branding.getPublicConfig(); }
  getBranding(): Promise<BrandingPayload> { return this.branding.getBranding(); }
  getReiwaPublicConfig(): Promise<PublicConfigPayload> {
    return this.branding.getReiwaPublicConfig();
  }

  // ── Web auth ────────────────────────────────────────────────────────────────
  webAuthRegister(
    login: string,
    password: string,
    options?: WebAuthRegisterOptions,
  ): Promise<WebAuthRegisterResult> {
    return this.webAuth.register(login, password, options);
  }
  webAuthLogin(login: string, password: string): Promise<WebAuthLoginResult> {
    return this.webAuth.login(login, password);
  }
  webAuthRecover(login: string): Promise<WebAuthRecoverResult> {
    return this.webAuth.recover(login);
  }
  webAuthChangePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean }> {
    return this.webAuth.changePassword(userId, currentPassword, newPassword);
  }

  /**
   * @deprecated Use `webAuth.login(login, password)` — the older
   * `web-account/sign-in` path is kept here only to avoid breaking SPA
   * bundles that haven't been rebuilt yet.
   */
  signInWebAccount(login: string, password: string) {
    return this.transport.request('POST', '/api/internal/user/web-account/sign-in', {
      login,
      password,
    });
  }

  /**
   * @deprecated Use `webAuth.recover(login)`.
   */
  initiatePasswordRecovery(email: string): Promise<WebAuthRecoverResult> {
    return this.webAuth.recover(email);
  }

  /**
   * @deprecated A password-reset-by-link flow is not exposed by the new
   * web-auth contract. Upstream returns 404 when hit; left in place so
   * the SPA bundle compiles.
   */
  resetPasswordByLink(tokenHash: string, newPasswordHash: string): Promise<{ success: boolean }> {
    return this.webAuth.changePassword('', tokenHash, newPasswordHash);
  }

  // ── Linking ─────────────────────────────────────────────────────────────────
  linkTelegramGenerate(userId: string): Promise<LinkTelegramGenerateResult> {
    return this.linking.telegram.generate(userId);
  }
  linkTelegramConsume(telegramId: string, code: string): Promise<LinkTelegramConsumeResult> {
    return this.linking.telegram.consume(telegramId, code);
  }
  linkEmailInitiate(userId: string, email: string): Promise<LinkEmailInitiateResult> {
    return this.linking.email.initiate(userId, email);
  }
  linkEmailVerify(userId: string, code: string): Promise<LinkEmailVerifyResult> {
    return this.linking.email.verify(userId, code);
  }

  // ── Push ────────────────────────────────────────────────────────────────────
  pushSubscribe(userId: string, subscription: WebPushSubscriptionPayload) {
    return this.push.subscribe(userId, subscription);
  }
  pushUnsubscribe(userId: string, endpoint: string) {
    return this.push.unsubscribe(userId, endpoint);
  }

  // ── Worker ──────────────────────────────────────────────────────────────────
  getExpiryAlerts() { return this.system.getExpiryAlerts(); }
}
