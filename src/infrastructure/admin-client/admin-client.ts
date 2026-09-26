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
 *
 * The 4th argument names the process the client speaks for — `api`, `bot` or
 * `worker` — and puts its identity and capabilities on every call
 * (`core/capabilities.ts`). Each main passes its own:
 *
 *   new AdminClient(baseUrl, apiKey, sharedSecret, { surface: 'api' });
 */
import { reiwaClientIdentity, type ReiwaSurface } from '../../core/capabilities.js';
import {
  ActivityNamespace,
  AddOnsNamespace,
  AdvertisingNamespace,
  AiConfigNamespace,
  BrandingNamespace,
  CatalogNamespace,
  DevicesNamespace,
  EventsNamespace,
  ExtAuthNamespace,
  FaqNamespace,
  LegalDocumentsNamespace,
  LandingNamespace,
  ConnectPageNamespace,
  LinkingNamespace,
  PartnerNamespace,
  PaymentsNamespace,
  PaymentMethodsNamespace,
  PromocodesNamespace,
  PushNamespace,
  QuestsNamespace,
  WheelNamespace,
  ContestsNamespace,
  UserHintsNamespace,
  ReferralsNamespace,
  SubscriptionNamespace,
  SupportNamespace,
  SystemNamespace,
  TrialNamespace,
  UserNamespace,
  WebAuthNamespace,
} from './namespaces/index.js';
import { AdminTransport } from './transport.js';

export interface AdminClientOptions {
  /**
   * The process this client speaks for. Without options the client sends no
   * identity at all, and the panel reads it as a cabinet from before the
   * headers: only tests build one that way.
   */
  readonly surface: ReiwaSurface;
}

export class AdminClient {
  private readonly transport: AdminTransport;

  // 18 namespaces composed onto the facade.
  readonly system: SystemNamespace;
  readonly catalog: CatalogNamespace;
  readonly user: UserNamespace;
  readonly subscription: SubscriptionNamespace;
  readonly trial: TrialNamespace;
  readonly payments: PaymentsNamespace;
  readonly paymentMethods: PaymentMethodsNamespace;
  readonly devices: DevicesNamespace;
  readonly activity: ActivityNamespace;
  readonly promocodes: PromocodesNamespace;
  readonly referrals: ReferralsNamespace;
  readonly partner: PartnerNamespace;
  readonly branding: BrandingNamespace;
  readonly landing: LandingNamespace;
  readonly connectPage: ConnectPageNamespace;
  readonly webAuth: WebAuthNamespace;
  readonly extAuth: ExtAuthNamespace;
  readonly linking: LinkingNamespace;
  readonly push: PushNamespace;
  readonly quests: QuestsNamespace;
  readonly wheel: WheelNamespace;
  readonly contests: ContestsNamespace;
  readonly userHints: UserHintsNamespace;
  readonly events: EventsNamespace;
  readonly support: SupportNamespace;
  readonly faq: FaqNamespace;
  readonly legalDocuments: LegalDocumentsNamespace;
  readonly addOns: AddOnsNamespace;
  readonly advertising: AdvertisingNamespace;
  readonly aiConfig: AiConfigNamespace;

  constructor(baseUrl: string, apiKey: string, sharedSecret?: string | null, options?: AdminClientOptions) {
    this.transport = new AdminTransport({
      baseUrl,
      apiKey,
      sharedSecret,
      identity: options === undefined ? null : reiwaClientIdentity(options.surface),
    });
    this.system = new SystemNamespace(this.transport);
    this.catalog = new CatalogNamespace(this.transport);
    this.user = new UserNamespace(this.transport);
    this.subscription = new SubscriptionNamespace(this.transport);
    this.trial = new TrialNamespace(this.transport);
    this.payments = new PaymentsNamespace(this.transport);
    this.paymentMethods = new PaymentMethodsNamespace(this.transport);
    this.devices = new DevicesNamespace(this.transport);
    this.activity = new ActivityNamespace(this.transport);
    this.promocodes = new PromocodesNamespace(this.transport);
    this.referrals = new ReferralsNamespace(this.transport);
    this.partner = new PartnerNamespace(this.transport);
    this.branding = new BrandingNamespace(this.transport);
    this.landing = new LandingNamespace(this.transport);
    this.connectPage = new ConnectPageNamespace(this.transport);
    this.webAuth = new WebAuthNamespace(this.transport);
    this.extAuth = new ExtAuthNamespace(this.transport);
    this.linking = new LinkingNamespace(this.transport);
    this.push = new PushNamespace(this.transport);
    this.quests = new QuestsNamespace(this.transport);
    this.wheel = new WheelNamespace(this.transport);
    this.contests = new ContestsNamespace(this.transport);
    this.userHints = new UserHintsNamespace(this.transport);
    this.events = new EventsNamespace(this.transport);
    this.support = new SupportNamespace(this.transport);
    this.faq = new FaqNamespace(this.transport);
    this.legalDocuments = new LegalDocumentsNamespace(this.transport);
    this.addOns = new AddOnsNamespace(this.transport);
    this.advertising = new AdvertisingNamespace(this.transport);
    this.aiConfig = new AiConfigNamespace(this.transport);
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
