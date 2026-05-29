/**
 * AdminClient — typed namespace facade for the rezeis-admin internal API.
 *
 * Wave 2 split the legacy 62-method god-class into 16 namespaces grouped
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
 * Wave 6B (this commit) removed the legacy 62-method delegate block
 * and the `request()` escape hatch. The SSE proxy is the only
 * consumer of `openStream()`; everything else flows through a
 * namespace.
 */
import {
  ActivityNamespace,
  AddOnsNamespace,
  BrandingNamespace,
  CatalogNamespace,
  DevicesNamespace,
  EventsNamespace,
  FaqNamespace,
  LinkingNamespace,
  PartnerNamespace,
  PaymentsNamespace,
  PromocodesNamespace,
  PushNamespace,
  ReferralsNamespace,
  SubscriptionNamespace,
  SupportNamespace,
  SystemNamespace,
  TrialNamespace,
  UserNamespace,
  WebAuthNamespace,
} from './namespaces/index.js';
import { AdminTransport } from './transport.js';

export class AdminClient {
  private readonly transport: AdminTransport;

  // 18 namespaces composed onto the facade.
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
  readonly support: SupportNamespace;
  readonly faq: FaqNamespace;
  readonly addOns: AddOnsNamespace;

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
    this.support = new SupportNamespace(this.transport);
    this.faq = new FaqNamespace(this.transport);
    this.addOns = new AddOnsNamespace(this.transport);
  }

  /**
   * Closes the underlying connection pool. Call from a SIGTERM/SIGINT
   * handler so in-flight requests finish before the process exits.
   */
  async close(): Promise<void> {
    await this.transport.close();
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
}
