// @vitest-environment jsdom

/**
 * «Оплатить балансом» while the partner balance is on hold — the purchase and
 * the renewal pages, rendered, in Russian, against the app's own React.
 *
 * For a while after a password recovery by subscription link the panel lets no
 * money leave the partner balance, and refuses a purchase paid with it. The
 * pages used to offer the balance anyway and, on the refusal, say «Не удалось
 * оплатить балансом» — as if something were broken. Now:
 *
 *   - while the partner info reports a hold, the balance is still offered (the
 *     buyer sees which option it is) but takes no tap, and a notice under it
 *     says it is temporary, why, and until when — in the operator's time zone,
 *     named; the button points at the notice with `aria-describedby`;
 *   - a hold whose end has passed, or no hold, or a panel too old to report one,
 *     leaves the button as it always was;
 *   - a refusal for a hold the page did not know about yet says so in the same
 *     words, and re-reads the partner info so the notice takes over.
 *
 * Network functions are the only thing replaced; the pages, the stores, the
 * reader of the refusal and the translations are the real ones. The refusal is
 * an `AxiosError` from the app's own axios, shaped as the cabinet sends it
 * (`test/api/partner-balance-hold-route.test.ts` pins that shape).
 *
 * ── How a page renders from `test/web` ────────────────────────────────────
 *
 * As in `password-recovery-screens.test.ts`: React, the renderer and the query
 * client are required from `web/src`'s point of view, and `react-router` and
 * `sonner` are mocked by path.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HOLD_CODE = 'WITHDRAWAL_HOLD_AFTER_RECOVERY';

const api = vi.hoisted(() => ({
  getPlatformPolicy: vi.fn(),
  getActionPolicy: vi.fn(),
  getQuote: vi.fn(),
  createCheckout: vi.fn(),
  getEnabledGateways: vi.fn(),
  activatePromocode: vi.fn(),
  getPaymentMethods: vi.fn(),
  getPartnerInfo: vi.fn(),
  payWithPartnerBalance: vi.fn(),
  getRenewalOptions: vi.fn(),
  getAllSubscriptions: vi.fn(),
  getPlans: vi.fn(),
  getAddOnEntitlements: vi.fn(),
  getSubscriptionAddOns: vi.fn(),
  createRenewalCheckout: vi.fn(),
}));
vi.mock('@/lib/api-client', () => api);

const route = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../../web/node_modules/react-router', () => {
  const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
  const { createElement } = requireFromApp('react') as {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  };
  return {
    useNavigate: () => route.navigate,
    useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    Link: ({ to, children }: { to: string; children?: unknown }) => createElement('a', { href: to }, children),
  };
});

// By the FILE the pages' `import "sonner"` resolves to. Mocked by the package
// directory instead, the mock is a different module from the one the pages
// load: their toasts go to the real sonner and a spy here records nothing.
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('../../web/node_modules/sonner/dist/index.mjs', () => ({ toast: toastSpy }));

vi.mock('@/lib/branding-provider', () => ({ useBranding: () => ({ defaultCurrency: 'RUB' }) }));
vi.mock('@/components/ui/back-button', () => ({ BackButton: () => null }));
vi.mock('@/features/purchase/components/promo-input', () => ({ PromoInput: () => null }));

interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  act(callback: () => Promise<void> | void): Promise<void>;
}
interface DomClientRuntime {
  createRoot(container: Element): { render(node: unknown): void; unmount(): void };
}
interface QueryRuntime {
  readonly QueryClient: new (config?: Record<string, unknown>) => unknown;
  readonly QueryClientProvider: unknown;
}
interface I18nRuntime {
  changeLanguage(language: string): Promise<unknown>;
  t(key: string, options?: Record<string, unknown>): string;
}
interface StoreRuntime {
  setState(partial: Record<string, unknown>): void;
  getState(): { reset(): void };
}
interface AxiosErrorRuntime {
  new (message: string, code: string, config: unknown, request: unknown, response: unknown): Error;
}

const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
const React = requireFromApp('react') as ReactRuntime;
const { createRoot } = requireFromApp('react-dom/client') as DomClientRuntime;
const { AxiosError } = requireFromApp('axios') as { AxiosError: AxiosErrorRuntime };
const QUERY_ENTRY = '../../web/node_modules/@tanstack/react-query/build/modern/index.js';

let query: QueryRuntime;
let i18n: I18nRuntime;
let PurchasePage: unknown;
let RenewalPage: unknown;
let purchaseStore: StoreRuntime;
let renewalStore: StoreRuntime;
let formatHoldEnd: (until: string, timezone: string | null, locale: string) => string;

let root: ReturnType<DomClientRuntime['createRoot']> | null = null;
let host: HTMLDivElement | null = null;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Relative: the hold must still be standing whenever this runs. */
const HOLD_UNTIL = new Date(Date.now() + 2 * DAY_MS).toISOString();

const GATEWAY = { id: 'PLATEGA', label: 'Platega', icon: '', currency: 'RUB' };

function partnerInfo(balanceHold?: { until: string; timezone: string | null } | null): Record<string, unknown> {
  const info: Record<string, unknown> = {
    id: 'partner-1',
    isActive: true,
    balance: 50_000,
    totalEarned: 90_000,
    totalWithdrawn: 40_000,
    programAvailable: true,
    balancePaymentEnabled: true,
    balanceCurrency: 'RUB',
    createdAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
  };
  // `undefined` stands for a panel from before the hold was reported at all.
  if (balanceHold !== undefined) info['balanceHold'] = balanceHold;
  return info;
}

/** The refusal as the page's axios raises it for the cabinet's 400. */
function holdRefusal(holdUntil: string | null): Error {
  const response = {
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: {},
    data: { code: HOLD_CODE, holdUntil, message: 'The partner balance is on hold after an account recovery' },
  };
  return new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', {}, {}, response);
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      matches: false,
      media,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
  query = (await import(/* @vite-ignore */ QUERY_ENTRY)) as QueryRuntime;
  ({ i18n } = (await import('@/i18n/i18n')) as { i18n: I18nRuntime });
  ({ default: PurchasePage } = await import('@/features/purchase/purchase-page'));
  ({ default: RenewalPage } = await import('@/features/renewal/renewal-page'));
  ({ usePurchaseStore: purchaseStore } = (await import('@/stores/purchase.store')) as unknown as {
    usePurchaseStore: StoreRuntime;
  });
  ({ useRenewalStore: renewalStore } = (await import('@/stores/renewal.store')) as unknown as {
    useRenewalStore: StoreRuntime;
  });
  ({ formatHoldEnd } = await import('@/lib/partner-balance-hold'));
});

beforeEach(async () => {
  for (const fn of [...Object.values(api), route.navigate, ...Object.values(toastSpy)]) fn.mockReset();
  api.getPlatformPolicy.mockResolvedValue({ accessMode: 'PUBLIC' });
  api.getActionPolicy.mockResolvedValue({ activeSubscriptionCount: 0, maxSubscriptions: 3, limitReached: false, canBuy: true });
  api.getQuote.mockResolvedValue({
    planId: 'plan-1',
    planName: 'Базовый',
    durationDays: 30,
    currency: 'RUB',
    basePrice: 300,
    discountPercent: 0,
    finalPrice: 300,
    gatewayType: GATEWAY.id,
  });
  const renewal = {
    userId: 'user-1',
    items: [
      {
        subscriptionId: 'sub-1',
        planId: 'plan-1',
        planName: 'Базовый',
        durationDays: 30,
        availableDurations: [{ id: 'd-30', days: 30 }],
        currency: 'RUB',
        amount: '300',
        discountPercent: 0,
        renewable: true,
        warnings: [],
      },
    ],
    currency: 'RUB',
    total: '300',
  };
  api.getRenewalOptions.mockResolvedValue(renewal);
  api.getAllSubscriptions.mockResolvedValue({ subscriptions: [] });
  purchaseStore.getState().reset();
  renewalStore.getState().reset();
  await i18n.changeLanguage('ru');
});

afterEach(async () => {
  if (root !== null) {
    const mounted = root;
    await React.act(async () => mounted.unmount());
  }
  host?.remove();
  root = null;
  host = null;
});

const tr = (key: string, options?: Record<string, unknown>): string => {
  const text = i18n.t(key, options);
  expect(text, `no translation for ${key}`).not.toBe(key);
  return text;
};

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(page: unknown): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false } } });
  await React.act(async () => {
    created.render(React.createElement(query.QueryClientProvider, { client }, React.createElement(page)));
  });
  await settle();
  return host;
}

async function openQuote(): Promise<HTMLDivElement> {
  purchaseStore.setState({
    step: 'quote',
    selectedPlan: { id: 'plan-1', name: 'Базовый', durations: [{ id: 'd-30', days: 30, prices: [] }] },
    selectedDuration: { id: 'd-30', days: 30, prices: [] },
    selectedGateway: GATEWAY,
  });
  return mount(PurchasePage);
}

async function openReview(): Promise<HTMLDivElement> {
  renewalStore.setState({ step: 'review', selectedSubscriptionIds: ['sub-1'], selectedGateway: GATEWAY });
  return mount(RenewalPage);
}

function balanceButton(page: HTMLElement): HTMLButtonElement {
  const label = tr('purchase.quote.payWithBalance', { amount: '500.00', currency: 'RUB' });
  const button = [...page.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  expect(button, `no «${label}» button`).toBeDefined();
  return button!;
}

function holdNotice(page: HTMLElement, until: string, timezone: string | null): HTMLElement | null {
  const text = tr('partnerBalanceHold.notice', { until: formatHoldEnd(until, timezone, 'ru') });
  return [...page.querySelectorAll<HTMLElement>('[id]')].find((node) => node.textContent === text) ?? null;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await React.act(async () => {
    button.click();
  });
  await settle();
}

describe.each([
  ['the purchase page', openQuote, 'NEW'],
  ['the renewal page', openReview, 'RENEW'],
] as const)('%s, while the partner balance is on hold', (page, open, purchaseType) => {
  it(`${page}: offers the balance but takes no tap, and says until when, why, and in whose clock`, async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ until: HOLD_UNTIL, timezone: 'Europe/Moscow' }));

    const page = await open();

    const button = balanceButton(page);
    expect(button.disabled).toBe(true);
    const notice = holdNotice(page, HOLD_UNTIL, 'Europe/Moscow');
    expect(notice, 'no hold notice in the operator’s time zone').not.toBeNull();
    expect(notice!.textContent).toMatch(/GMT\+3/);
    expect(button.getAttribute('aria-describedby')).toBe(notice!.id);
    await click(button);
    expect(api.payWithPartnerBalance).not.toHaveBeenCalled();
  });

  it(`${page}: names UTC when the operator set no time zone`, async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo({ until: HOLD_UNTIL, timezone: null }));

    const page = await open();

    const notice = holdNotice(page, HOLD_UNTIL, null);
    expect(notice, 'no hold notice in UTC').not.toBeNull();
    expect(notice!.textContent).toMatch(/UTC/);
  });

  it.each([
    ['no hold', null],
    ['a hold that has ended', { until: new Date(Date.now() - 60_000).toISOString(), timezone: 'Europe/Moscow' }],
    ['a panel too old to report holds', undefined],
  ] as const)(`${page}: leaves the button as it was with %s`, async (_case, balanceHold) => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo(balanceHold));
    api.payWithPartnerBalance.mockResolvedValue({ paymentId: 'pay-1' });

    const page = await open();

    const button = balanceButton(page);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(page.textContent).not.toContain(tr('partnerBalanceHold.notice', { until: '' }).slice(0, 30));
    await click(button);
    expect(api.payWithPartnerBalance).toHaveBeenCalledTimes(1);
    expect(api.payWithPartnerBalance.mock.calls[0]![0]).toMatchObject({ purchaseType, planId: 'plan-1', durationDays: 30 });
  });

  it(`${page}: says so when the payment is refused for a hold it did not know of, and then shows the notice`, async () => {
    api.getPartnerInfo
      .mockResolvedValueOnce(partnerInfo(null))
      .mockResolvedValue(partnerInfo({ until: HOLD_UNTIL, timezone: 'Europe/Moscow' }));
    api.payWithPartnerBalance.mockRejectedValue(holdRefusal(HOLD_UNTIL));

    const page = await open();
    await click(balanceButton(page));

    // The copy on screen predates the hold, so its zone is not known: UTC, named.
    expect(toastSpy.error).toHaveBeenCalledWith(
      tr('partnerBalanceHold.refusedUntil', { until: formatHoldEnd(HOLD_UNTIL, null, 'ru') }),
    );
    expect(toastSpy.error).not.toHaveBeenCalledWith(tr('purchase.quote.balanceError'));
    expect(api.getPartnerInfo).toHaveBeenCalledTimes(2);
    expect(balanceButton(page).disabled).toBe(true);
    expect(holdNotice(page, HOLD_UNTIL, 'Europe/Moscow')).not.toBeNull();
  });

  it(`${page}: says it is on hold, without a date, when the refusal carries none`, async () => {
    api.getPartnerInfo.mockResolvedValue(partnerInfo(null));
    api.payWithPartnerBalance.mockRejectedValue(holdRefusal(null));

    const page = await open();
    await click(balanceButton(page));

    expect(toastSpy.error).toHaveBeenCalledWith(tr('partnerBalanceHold.refused'));
  });
});
