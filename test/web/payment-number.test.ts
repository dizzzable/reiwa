// @vitest-environment jsdom

/**
 * THE PAYMENT NUMBER A SUBSCRIBER CAN QUOTE TO SUPPORT.
 *
 * Support finds a payment by its number, and the cabinet showed it nowhere: not
 * in the payment history (`settings/transactions-page.tsx`), although every row
 * carries it, and not on the screen a payment ends on
 * (`payment/payment-return-page.tsx`), although that screen reads it from its
 * own address. Both now show «Номер платежа» with a copy button, and the button
 * says «Номер скопирован» only when `copyText` answered that the value arrived.
 *
 * The clipboard is the one thing faked, and it is faked as the BROWSER — a
 * `navigator.clipboard` that accepts or refuses, and a `document.execCommand`
 * for the fallback — so the real `copyText` decides, not a stub of it.
 *
 * ── How a page renders from `test/web` ────────────────────────────────────
 *
 * The repository root and `web/` each install React (19.2.7 and 19.2.8). A bare
 * `react` import here would load the root copy, and the page's hooks would run
 * against the other one — "Invalid hook call". So React and the renderer are
 * required from `web/src`'s point of view (plain CommonJS, one module cache);
 * and the QueryClient provider is imported from the exact ESM file the page's
 * own `@tanstack/react-query` import resolves to, `build/modern/index.js` —
 * the package's directory resolves elsewhere, and a provider from another copy
 * is a provider the page cannot see. If that file ever moves, the import fails
 * loudly here rather than passing against a different module.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PAYMENT_ID = 'cmfk2x9pq0011abcd1234efgh';

const api = vi.hoisted(() => ({
  getTransactions: vi.fn(),
  getPaymentStatus: vi.fn(),
  abandonCheckout: vi.fn(async () => {
    throw new Error('this spec never abandons a checkout');
  }),
}));
vi.mock('@/lib/api-client', () => api);

const route = vi.hoisted(() => ({ search: '' }));
const navigate = vi.hoisted(() => vi.fn());
// By path: a bare `react-router` from here would resolve to nothing at the root.
vi.mock('../../web/node_modules/react-router', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(route.search), vi.fn()],
}));

vi.mock('@/lib/branding-provider', () => ({
  useBranding: () => ({ branding: { primary: '#22c55e' } }),
}));

interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  act(callback: () => Promise<void>): Promise<void>;
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
}

const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
const React = requireFromApp('react') as ReactRuntime;
const { createRoot } = requireFromApp('react-dom/client') as DomClientRuntime;
const QUERY_ENTRY = '../../web/node_modules/@tanstack/react-query/build/modern/index.js';

let query: QueryRuntime;
let i18n: I18nRuntime;
let TransactionsPage: unknown;
let PaymentReturnPage: unknown;

let root: ReturnType<DomClientRuntime['createRoot']> | null = null;
let host: HTMLDivElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  query = (await import(/* @vite-ignore */ QUERY_ENTRY)) as QueryRuntime;
  ({ i18n } = (await import('@/i18n/i18n')) as { i18n: I18nRuntime });
  ({ default: TransactionsPage } = await import('@/features/settings/transactions-page'));
  ({ default: PaymentReturnPage } = await import('@/features/payment/payment-return-page'));
});

beforeEach(async () => {
  api.getTransactions.mockReset();
  api.getPaymentStatus.mockReset();
  navigate.mockReset();
  route.search = '';
  window.sessionStorage.clear();
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

/** The browser's clipboard, as it answers. */
function clipboard(answer: 'accepts' | 'refuses' | 'absent', fallbackWorks = false): void {
  writeText = vi.fn(async () => {
    if (answer === 'refuses') throw new DOMException('Document is not focused.', 'NotAllowedError');
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: answer === 'absent' ? undefined : { writeText },
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn(() => fallbackWorks),
  });
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
  return host;
}

/** Lets pending promises and the renders they cause land. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function copyButton(container: HTMLElement, name: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (button === null) throw new Error(`no button named «${name}» in: ${container.textContent ?? ''}`);
  return button;
}

/** The live status line of the payment-number block this button belongs to. */
function statusOf(button: HTMLButtonElement): string {
  const block = button.parentElement?.parentElement;
  const status = block?.querySelector('[role="status"]');
  if (status === null || status === undefined) throw new Error('the payment number has no status line');
  return status.textContent ?? '';
}

async function press(button: HTMLButtonElement): Promise<void> {
  await React.act(async () => {
    button.click();
  });
  await settle();
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmfk2x9pq0010abcd1234efgh',
    paymentId: PAYMENT_ID,
    status: 'COMPLETED',
    gatewayType: 'YOOKASSA',
    currency: 'RUB',
    amount: '299',
    title: 'Pro',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('the payment history', () => {
  it('shows every payment with its number and a named copy button', async () => {
    api.getTransactions.mockResolvedValue({
      transactions: [historyRow(), historyRow({ id: 'second', paymentId: 'cmfk2x9pq0021abcd1234efgh' })],
    });

    const page = await mount(TransactionsPage);
    await settle();

    const text = page.textContent ?? '';
    expect(text).toContain('Номер платежа');
    expect(text).toContain(PAYMENT_ID);
    expect(text).toContain('cmfk2x9pq0021abcd1234efgh');
    expect(page.querySelectorAll('button[aria-label="Скопировать номер платежа"]')).toHaveLength(2);
  });

  it('says «Номер скопирован» once the clipboard took the number', async () => {
    api.getTransactions.mockResolvedValue({ transactions: [historyRow()] });
    const page = await mount(TransactionsPage);
    await settle();
    clipboard('accepts');
    const button = copyButton(page, 'Скопировать номер платежа');

    await press(button);

    expect(writeText).toHaveBeenCalledWith(PAYMENT_ID);
    expect(statusOf(button)).toBe('Номер скопирован');
  });

  it('says the copy failed — and never that it worked — when the browser refuses both ways', async () => {
    api.getTransactions.mockResolvedValue({ transactions: [historyRow()] });
    const page = await mount(TransactionsPage);
    await settle();
    clipboard('refuses', false);
    const button = copyButton(page, 'Скопировать номер платежа');

    await press(button);

    expect(statusOf(button)).toBe('Не удалось скопировать. Выделите номер и скопируйте его вручную.');
    expect(page.textContent).not.toContain('Номер скопирован');
  });

  it('shows an imported payment by its own number, without the platform it came from, and copies that', async () => {
    // The panel's importers namespace a donor platform's number (`bedolaga:4821`);
    // the subscriber reads — and quotes to support — the number alone.
    api.getTransactions.mockResolvedValue({ transactions: [historyRow({ paymentId: 'bedolaga:4821' })] });
    const page = await mount(TransactionsPage);
    await settle();
    clipboard('accepts');
    const button = copyButton(page, 'Скопировать номер платежа');

    expect(page.textContent).toContain('4821');
    expect(page.textContent).not.toContain('bedolaga');
    await press(button);

    expect(writeText).toHaveBeenCalledWith('4821');
    expect(statusOf(button)).toBe('Номер скопирован');
  });

  it('leaves a number that only looks namespaced alone', async () => {
    // StealthNet imports keep the donor's order id as it was; only the three
    // namespaces the importers write are taken off.
    api.getTransactions.mockResolvedValue({ transactions: [historyRow({ paymentId: 'order:77' })] });
    const page = await mount(TransactionsPage);
    await settle();

    expect(page.textContent).toContain('order:77');
  });

  it('copies through the selection fallback where the clipboard API is missing', async () => {
    api.getTransactions.mockResolvedValue({ transactions: [historyRow()] });
    const page = await mount(TransactionsPage);
    await settle();
    clipboard('absent', true);
    const button = copyButton(page, 'Скопировать номер платежа');

    await press(button);

    expect(statusOf(button)).toBe('Номер скопирован');
  });
});

describe('the payment return screen', () => {
  it('shows «Номер платежа» for the payment it is waiting on, and copies it', async () => {
    route.search = `paymentId=${PAYMENT_ID}`;
    api.getPaymentStatus.mockResolvedValue({
      paymentId: PAYMENT_ID,
      status: 'PENDING',
      purchaseType: 'RENEW',
      subscriptionProvisioningStatus: 'NOT_APPLICABLE',
      failureReason: null,
    });

    const page = await mount(PaymentReturnPage);
    await settle();

    expect(api.getPaymentStatus).toHaveBeenCalledWith(PAYMENT_ID);
    expect(page.textContent).toContain('Номер платежа');
    expect(page.textContent).toContain(PAYMENT_ID);

    clipboard('accepts');
    const button = copyButton(page, 'Скопировать номер платежа');
    expect(statusOf(button)).toBe('');
    await press(button);

    expect(writeText).toHaveBeenCalledWith(PAYMENT_ID);
    expect(statusOf(button)).toBe('Номер скопирован');
  });

  it('says it in English for an English cabinet', async () => {
    await i18n.changeLanguage('en');
    route.search = `paymentId=${PAYMENT_ID}`;
    api.getPaymentStatus.mockResolvedValue({
      paymentId: PAYMENT_ID,
      status: 'PENDING',
      purchaseType: 'RENEW',
      subscriptionProvisioningStatus: 'NOT_APPLICABLE',
      failureReason: null,
    });

    const page = await mount(PaymentReturnPage);
    await settle();

    expect(page.textContent).toContain('Payment number');
    expect(copyButton(page, 'Copy payment number')).toBeTruthy();
  });
});
