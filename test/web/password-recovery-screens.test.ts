// @vitest-environment jsdom

/**
 * THE CABINET SCREENS OF PASSWORD RECOVERY — rendered, in Russian, against the
 * app's own React.
 *
 *   - «Забыли пароль?» (`/recover`) shows ONE message for every login, and the
 *     ways on for somebody it cannot help;
 *   - `/reset-password` takes the token from the link's fragment (the Mini App
 *     fallback's query, or the subscription screen's navigation state), erases
 *     it from the address, says "expired" / "used" before anyone types, hashes
 *     the new password like registration, and — when only the sign-in after it
 *     failed — says the password IS changed and hands the login to `/sign-in`;
 *   - `/recover/subscription` hands the token on in memory, never in the URL,
 *     shows the panel's one failure message as it is, and the recovery form's
 *     one answer for an account that has a channel;
 *   - «Сохраните данные для входа» copies, shares and saves honestly, only
 *     offers what the browser can do, and keeps the destination on a detour to
 *     the privacy page, which then offers «Продолжить»;
 *   - registration ends on that screen instead of jumping into the cabinet;
 *   - the privacy dialog's password change is a real form a password manager
 *     can read.
 *
 * Network functions are the only thing replaced; the pages, the hashing, the
 * clipboard fallback and the translations are the real ones.
 *
 * ── How a page renders from `test/web` ────────────────────────────────────
 *
 * The root and `web/` each install React (19.2.7 and 19.2.8). React and the
 * renderer are therefore required from `web/src`'s point of view, and the
 * QueryClient provider imported from the exact file the pages' own
 * `@tanstack/react-query` resolves to — the technique `payment-number.test.ts`
 * in this directory documents. `react-router` and `sonner` are mocked by path
 * for the same reason: a bare specifier from here resolves to nothing.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'f'.repeat(64);

const api = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
  inspectResetLink: vi.fn(),
  resetPassword: vi.fn(),
  recoverBySubscription: vi.fn(),
}));
vi.mock('@/features/auth/password-reset-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));

const appApi = vi.hoisted(() => ({
  registerUser: vi.fn(),
  checkUsername: vi.fn(async () => ({ available: true })),
  login: vi.fn(),
  changePasswordAuth: vi.fn(async () => ({ success: true })),
  claimAccount: vi.fn(),
  linkExistingAccount: vi.fn(),
  finishExternalSetup: vi.fn(),
  signOut: vi.fn(),
  initiateEmailLink: vi.fn(),
  initiateTelegramLink: vi.fn(),
  verifyEmailLink: vi.fn(),
  getPlatformPolicy: vi.fn(),
}));
vi.mock('@/lib/api-client', () => appApi);

const route = vi.hoisted(() => ({
  location: { pathname: '/', search: '', hash: '', state: null as unknown },
  navigate: vi.fn(),
}));
vi.mock('../../web/node_modules/react-router', () => {
  const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
  const { createElement } = requireFromApp('react') as {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  };
  return {
    useNavigate: () => route.navigate,
    useLocation: () => route.location,
    useSearchParams: () => [new URLSearchParams(route.location.search), vi.fn()],
    Link: ({ to, children, className }: { to: string; children?: unknown; className?: string }) =>
      createElement('a', { href: to, className }, children),
  };
});

// By the FILE the pages' `import { toast } from 'sonner'` resolves to: mocked by
// the package directory, the pages kept the real sonner and this spy saw nothing.
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../../web/node_modules/sonner/dist/index.mjs', () => ({ toast: toastSpy }));

// The signed-in customer's password state, first password and «Выйти на всех
// устройствах». Every case sees an account WITH a password unless it says
// otherwise, so the ordinary change form is what renders.
const securityApi = vi.hoisted(() => ({
  getPasswordState: vi.fn(),
  setFirstPassword: vi.fn(),
  signOutOtherDevices: vi.fn(),
}));
vi.mock('@/features/auth/account-security-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...securityApi,
}));

const sessionState = vi.hoisted(() => ({
  value: {
    session: null as null | {
      telegramId: string | null;
      webAccount: { login: string | null; emailVerifiedAt: string | null } | null;
    },
    isLoading: false,
    isAuthenticated: false,
  },
}));
vi.mock('@/hooks/use-session', () => ({
  useSession: () => sessionState.value,
  SESSION_QUERY_KEY: ['session'],
}));

const brandingState = vi.hoisted(() => ({ value: { botUsername: 'reiwa_bot' as string | null, emailEnabled: true } }));
vi.mock('@/lib/branding-provider', () => ({ useBranding: () => brandingState.value }));

vi.mock('@/features/support/guest-support-link', () => ({ GuestSupportLink: () => null }));
vi.mock('@/components/ui/network-bg', () => ({ NetworkBg: () => null }));
vi.mock('@/features/auth/external-auth-buttons', () => ({ ExternalAuthButtons: () => null }));
vi.mock('@/components/access-mode-banner', () => ({ AccessModeBanner: () => null }));
vi.mock('@/components/legal-document-dialog', () => ({ LegalDocumentDialog: () => null }));
vi.mock('@/components/ui/back-button', () => ({ BackButton: () => null }));
vi.mock('@/components/ui/brand-logo', () => ({ BrandLogo: () => null }));
vi.mock('@/components/ui/entry-brand-tile', () => ({ EntryBrandTile: () => null }));
// `useSubscriptionLinkRecovery` stays the real hook: it reads the mocked
// `getPlatformPolicy` through the real query cache.
vi.mock('@/lib/use-access-mode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAccessMode: () => ({ registrationBlocked: false, restricted: false, inviteOnly: false, isLoading: false }),
}));
vi.mock('@/lib/use-legal-documents', () => ({
  useLegalDocuments: () => ({ documents: [], isLoading: false, failed: false, retry: () => undefined }),
}));
vi.mock('@/components/ui/dialog', () => {
  const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
  const { createElement } = requireFromApp('react') as {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  };
  const passThrough = ({ children }: { children?: unknown }) => createElement('div', null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children?: unknown }) => (open ? createElement('div', null, children) : null),
    DialogContent: passThrough,
    DialogHeader: passThrough,
    DialogTitle: passThrough,
  };
});

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

const requireFromApp = createRequire(join(process.cwd(), 'web', 'src', 'main.tsx'));
const React = requireFromApp('react') as ReactRuntime;
const { createRoot } = requireFromApp('react-dom/client') as DomClientRuntime;
const QUERY_ENTRY = '../../web/node_modules/@tanstack/react-query/build/modern/index.js';

let query: QueryRuntime;
let i18n: I18nRuntime;
let RecoverPage: unknown;
let ResetPasswordPage: unknown;
let RecoverSubscriptionPage: unknown;
let RegisterPage: unknown;
let PrivacyPage: unknown;
let ClaimPage: unknown;
let FinishSetupPage: unknown;
let ChangePasswordPage: unknown;
let SignInPage: unknown;
let SaveCredentialsScreen: unknown;

let root: ReturnType<DomClientRuntime['createRoot']> | null = null;
let host: HTMLDivElement | null = null;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no matchMedia; two pages read it at module level.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  });
  query = (await import(/* @vite-ignore */ QUERY_ENTRY)) as QueryRuntime;
  ({ i18n } = (await import('@/i18n/i18n')) as { i18n: I18nRuntime });
  ({ default: RecoverPage } = await import('@/features/auth/recover-page'));
  ({ default: ResetPasswordPage } = await import('@/features/auth/reset-password-page'));
  ({ default: RecoverSubscriptionPage } = await import('@/features/auth/recover-subscription-page'));
  ({ default: RegisterPage } = await import('@/features/auth/register-page'));
  ({ default: PrivacyPage } = await import('@/features/settings/privacy-page'));
  ({ default: ClaimPage } = await import('@/features/auth/claim-page'));
  ({ default: FinishSetupPage } = await import('@/features/auth/finish-setup-page'));
  ({ default: ChangePasswordPage } = await import('@/features/auth/change-password-page'));
  ({ default: SignInPage } = await import('@/features/auth/sign-in-page'));
  ({ SaveCredentialsScreen } = await import('@/features/auth/save-credentials'));
});

beforeEach(async () => {
  for (const fn of [
    ...Object.values(api),
    ...Object.values(appApi),
    ...Object.values(securityApi),
    ...Object.values(toastSpy),
    route.navigate,
  ]) {
    fn.mockReset();
  }
  securityApi.getPasswordState.mockResolvedValue({ hasPassword: true });
  appApi.checkUsername.mockResolvedValue({ available: true });
  appApi.changePasswordAuth.mockResolvedValue({ success: true });
  // The operator's «Восстановление пароля по ссылке подписки»: ON unless a case says otherwise.
  appApi.getPlatformPolicy.mockResolvedValue({ subscriptionLinkRecovery: true });
  route.location = { pathname: '/', search: '', hash: '', state: null };
  sessionState.value = { session: null, isLoading: false, isAuthenticated: false };
  brandingState.value = { botUsername: 'reiwa_bot', emailEnabled: true };
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
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
  // i18next answers a missing key with the key itself; a test matching that
  // would pass against a page that renders the raw key.
  expect(text, `no translation for ${key}`).not.toBe(key);
  return text;
};

async function mount(element: unknown): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false } } });
  await React.act(async () => {
    created.render(React.createElement(query.QueryClientProvider, { client }, element));
  });
  await settle();
  return host;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function typeInto(field: Element | null, value: string): Promise<void> {
  if (!(field instanceof HTMLInputElement) && !(field instanceof HTMLTextAreaElement)) {
    throw new Error('no such field');
  }
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  return React.act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`no button «${text}» in: ${container.textContent ?? ''}`);
  return button;
}

async function press(element: HTMLElement): Promise<void> {
  await React.act(async () => {
    element.click();
  });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  if (!(form instanceof HTMLFormElement)) throw new Error('no form');
  await React.act(async () => {
    form.requestSubmit();
  });
  await settle();
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function upstreamError(status: number, data: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data, headers: {} } });
}

// ── «Забыли пароль?» ─────────────────────────────────────────────────────────

describe('/recover', () => {
  it('sends what was typed and shows the one message every login gets', async () => {
    api.requestPasswordReset.mockResolvedValue({ status: 'accepted' });
    const page = await mount(React.createElement(RecoverPage));

    const field = page.querySelector('input[name="username"]');
    expect(field?.getAttribute('autocomplete')).toBe('username');
    await typeInto(field, '  alice@example.com ');
    await submit(page.querySelector('form'));

    expect(api.requestPasswordReset.mock.calls).toEqual([['alice@example.com']]);
    const answer = page.querySelector('[data-testid="recover-answer"]');
    expect(answer?.textContent).toContain(tr('auth.recover.sent'));
    expect(answer?.textContent).toContain('15 минут');
  });

  it('says recovery by link is unavailable when the server does not send links', async () => {
    api.requestPasswordReset.mockResolvedValue({ status: 'unavailable' });
    const page = await mount(React.createElement(RecoverPage));

    await typeInto(page.querySelector('input[name="username"]'), 'alice');
    await submit(page.querySelector('form'));

    expect(page.querySelector('[data-testid="recover-answer"]')?.textContent).toContain(tr('auth.recover.unavailable'));
  });

  it('offers the bot for a forgotten login and the subscription link for no access at all', async () => {
    const page = await mount(React.createElement(RecoverPage));

    const shortcut = page.querySelector('[data-testid="recover-telegram-shortcut"]');
    expect(shortcut?.getAttribute('href')).toBe('https://t.me/reiwa_bot?start=pwreset');
    expect(page.textContent).toContain(tr('auth.recover.noAccessTitle'));
    expect([...page.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain('/recover/subscription');
  });

  it('shows no bot shortcut when the bot is unknown', async () => {
    brandingState.value = { botUsername: null, emailEnabled: true };
    const page = await mount(React.createElement(RecoverPage));
    expect(page.querySelector('[data-testid="recover-telegram-shortcut"]')).toBeNull();
  });
});

// ── /reset-password ─────────────────────────────────────────────────────────

describe('/reset-password', () => {
  it('takes the token from the fragment of the link, erases it from the address, and names the login', async () => {
    route.location = { pathname: '/reset-password', search: '', hash: `#token=${TOKEN}`, state: null };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });

    const page = await mount(React.createElement(ResetPasswordPage));

    expect(api.inspectResetLink.mock.calls).toEqual([[TOKEN]]);
    expect(route.navigate).toHaveBeenCalledWith('/reset-password', { replace: true, state: null });
    expect(page.querySelector('[data-testid="reset-login"]')?.textContent).toBe(tr('auth.reset.subtitle', { login: 'alice' }));
    const username = page.querySelector<HTMLInputElement>('input[name="username"]');
    expect(username?.value).toBe('alice');
    expect(username?.getAttribute('autocomplete')).toBe('username');
    expect(
      [...page.querySelectorAll('input[type="password"]')].map((input) => input.getAttribute('autocomplete')),
    ).toEqual(['new-password', 'new-password']);
  });

  it('hashes the new password like registration, then shows it masked on the save screen', async () => {
    route.location = { pathname: '/reset-password', search: `?token=${TOKEN}`, hash: '', state: null };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });
    api.resetPassword.mockResolvedValue({ success: true, redirectUrl: '/dashboard', login: 'alice' });
    const page = await mount(React.createElement(ResetPasswordPage));

    await typeInto(page.querySelector('#reset-password'), 'Correct-Horse-9');
    await typeInto(page.querySelector('#reset-password-repeat'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(api.resetPassword.mock.calls).toEqual([[TOKEN, sha256('Correct-Horse-9')]]);
    expect(page.querySelector('[data-testid="save-credentials"]')).not.toBeNull();
    expect(page.querySelector('[data-testid="saved-login"]')?.textContent).toBe('alice');
    expect(page.querySelector('[data-testid="saved-password"]')?.textContent).not.toContain('Correct-Horse-9');
    await press(buttonNamed(page, tr('auth.saveCredentials.show')));
    expect(page.querySelector('[data-testid="saved-password"]')?.textContent).toBe('Correct-Horse-9');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('Correct-Horse-9');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('Correct-Horse-9');

    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate).toHaveBeenLastCalledWith('/dashboard', { replace: true });
  });

  it('will not send passwords that differ', async () => {
    route.location = { pathname: '/reset-password', search: `?token=${TOKEN}`, hash: '', state: null };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });
    const page = await mount(React.createElement(ResetPasswordPage));

    await typeInto(page.querySelector('#reset-password'), 'Correct-Horse-9');
    await typeInto(page.querySelector('#reset-password-repeat'), 'Correct-Horse-8');
    await submit(page.querySelector('form'));

    expect(page.textContent).toContain(tr('auth.reset.mismatch'));
    expect(page.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  const deadEnds: Array<[string, 'expired' | 'used', string]> = [
    ['an expired link', 'expired', 'auth.reset.expiredTitle'],
    ['a used link', 'used', 'auth.reset.usedTitle'],
  ];
  for (const [what, status, title] of deadEnds) {
    it(`says so before anybody types, for ${what}`, async () => {
      route.location = { pathname: '/reset-password', search: `?token=${TOKEN}`, hash: '', state: null };
      api.inspectResetLink.mockResolvedValue({ status });

      const page = await mount(React.createElement(ResetPasswordPage));

      expect(page.querySelector('[data-testid="reset-dead-end"]')?.textContent).toContain(tr(title));
      expect(page.querySelector('form')).toBeNull();
      await press(buttonNamed(page, tr('auth.reset.requestNew')));
      expect(route.navigate).toHaveBeenLastCalledWith('/recover');
    });
  }

  it('calls a page without a token incomplete and asks nothing', async () => {
    route.location = { pathname: '/reset-password', search: '', hash: '', state: null };
    const page = await mount(React.createElement(ResetPasswordPage));

    expect(page.querySelector('[data-testid="reset-dead-end"]')?.textContent).toContain(tr('auth.reset.missingTitle'));
    expect(api.inspectResetLink).not.toHaveBeenCalled();
  });

  it('switches to "used" when the link was spent between opening and saving', async () => {
    route.location = { pathname: '/reset-password', search: `?token=${TOKEN}`, hash: '', state: null };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });
    api.resetPassword.mockRejectedValue(upstreamError(410, { code: 'RESET_LINK_USED' }));
    const page = await mount(React.createElement(ResetPasswordPage));

    await typeInto(page.querySelector('#reset-password'), 'Correct-Horse-9');
    await typeInto(page.querySelector('#reset-password-repeat'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(page.querySelector('[data-testid="reset-dead-end"]')?.getAttribute('data-phase')).toBe('used');
  });

  it('takes a token handed over in navigation state, and erases that state', async () => {
    route.location = { pathname: '/reset-password', search: '', hash: '', state: { resetToken: TOKEN, login: 'alice' } };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });

    await mount(React.createElement(ResetPasswordPage));

    expect(api.inspectResetLink.mock.calls).toEqual([[TOKEN]]);
    expect(route.navigate).toHaveBeenCalledWith('/reset-password', { replace: true, state: null });
  });

  it('still takes `?token=` — the Mini App button, whose fragment belongs to Telegram — and erases it', async () => {
    route.location = {
      pathname: '/reset-password',
      search: `?token=${TOKEN}`,
      hash: '#tgWebAppData=query_id%3DAAE&tgWebAppVersion=8.0',
      state: null,
    };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });

    await mount(React.createElement(ResetPasswordPage));

    expect(api.inspectResetLink.mock.calls).toEqual([[TOKEN]]);
    expect(route.navigate).toHaveBeenCalledWith('/reset-password', { replace: true, state: null });
  });

  it('says the password IS changed when only the sign-in failed, and hands the login to the sign-in form', async () => {
    route.location = { pathname: '/reset-password', search: '', hash: `#token=${TOKEN}`, state: null };
    api.inspectResetLink.mockResolvedValue({ status: 'valid', login: 'alice', expiresAt: '2026-09-18T12:15:00Z' });
    api.resetPassword.mockRejectedValue(upstreamError(500, { code: 'SESSION_FAILED', login: 'Alice' }));
    const page = await mount(React.createElement(ResetPasswordPage));

    await typeInto(page.querySelector('#reset-password'), 'Correct-Horse-9');
    await typeInto(page.querySelector('#reset-password-repeat'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    const changed = page.querySelector('[data-testid="reset-changed"]');
    expect(changed?.querySelector('h1')?.textContent).toBe('Пароль изменён — войдите с новым паролем');
    expect(changed?.querySelector('[data-testid="reset-changed-login"]')?.textContent).toBe(
      tr('auth.reset.changedLogin', { login: 'Alice' }),
    );
    expect(page.querySelector('form')).toBeNull();
    expect(page.textContent).not.toContain(tr('auth.reset.error'));

    route.navigate.mockClear();
    await press(buttonNamed(page, tr('auth.reset.signIn')));
    expect(route.navigate.mock.calls).toEqual([['/sign-in', { replace: true, state: { login: 'Alice' } }]]);
  });
});

// ── /sign-in, arriving from a reset ─────────────────────────────────────────

describe('the operator switch «Восстановление пароля по ссылке подписки»', () => {
  const policies: Array<[string, Record<string, unknown>]> = [
    ['switched off', { subscriptionLinkRecovery: false }],
    ['absent — a panel that predates the switch', {}],
  ];

  for (const [situation, policy] of policies) {
    it(`/recover offers support instead of the subscription link when ${situation}`, async () => {
      appApi.getPlatformPolicy.mockResolvedValue(policy);

      const page = await mount(React.createElement(RecoverPage));

      const block = page.querySelector('[data-testid="recover-no-access"]');
      expect(block?.textContent).toContain(tr('auth.recover.noAccessSupportOnly'));
      expect([...page.querySelectorAll('a')].map((link) => link.getAttribute('href'))).not.toContain(
        '/recover/subscription',
      );
      expect(page.textContent).not.toContain(tr('auth.recover.noAccessAction'));
    });

    it(`/recover/subscription opened directly says it is off and shows no form when ${situation}`, async () => {
      appApi.getPlatformPolicy.mockResolvedValue(policy);

      const page = await mount(React.createElement(RecoverSubscriptionPage));

      expect(page.querySelector('h1')?.textContent).toBe('Восстановление по ссылке подписки отключено');
      expect(page.querySelector('[data-testid="recover-subscription-disabled"]')?.textContent).toBe(
        tr('auth.recoverSubscription.disabledBody'),
      );
      expect(page.querySelector('form')).toBeNull();
      expect(api.recoverBySubscription).not.toHaveBeenCalled();
    });
  }

  it('/recover offers the subscription link when switched on', async () => {
    appApi.getPlatformPolicy.mockResolvedValue({ subscriptionLinkRecovery: true });

    const page = await mount(React.createElement(RecoverPage));

    expect([...page.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain('/recover/subscription');
    expect(page.textContent).not.toContain(tr('auth.recover.noAccessSupportOnly'));
  });

  it('turns the form into the "off" notice when the panel refuses because it was switched off meanwhile', async () => {
    api.recoverBySubscription.mockRejectedValue(upstreamError(403, { code: 'RECOVERY_DISABLED' }));
    const page = await mount(React.createElement(RecoverSubscriptionPage));

    await typeInto(page.querySelector('textarea'), 'https://sub.example.com/AliceShort01q');
    await typeInto(page.querySelector('input[name="username"]'), 'alice');
    await submit(page.querySelector('form'));

    expect(page.querySelector('form')).toBeNull();
    expect(page.querySelector('[data-testid="recover-subscription-disabled"]')).not.toBeNull();
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it('has its sentences in both languages', async () => {
    const keys = [
      'auth.recover.noAccessSupportOnly',
      'auth.recoverSubscription.loading',
      'auth.recoverSubscription.disabledTitle',
      'auth.recoverSubscription.disabledBody',
    ];
    const russian = keys.map((key) => tr(key));
    await i18n.changeLanguage('en');
    const english = keys.map((key) => tr(key));
    expect(english[2]).toBe('Recovery by subscription link is turned off');
    english.forEach((text, index) => expect(text, keys[index]).not.toBe(russian[index]));
  });
});

describe('/sign-in for an account imported without a password', () => {
  async function signInAs(login: string, password: string): Promise<HTMLElement> {
    route.location = { pathname: '/sign-in', search: '', hash: '', state: null };
    const page = await mount(React.createElement(SignInPage));
    await typeInto(page.querySelector('input[name="username"]'), login);
    await typeInto(page.querySelector('input[name="password"]'), password);
    await submit(page.querySelector('form'));
    return page;
  }

  it('says there is no password yet and that the link is in Telegram — and goes nowhere', async () => {
    appApi.login.mockRejectedValue(upstreamError(401, { code: 'PASSWORD_NOT_SET', delivery: 'telegram' }));

    const page = await signInAs('imported_user', 'whatever-typed');

    const notice = page.querySelector('[data-testid="signin-password-not-set"]');
    expect(notice?.textContent).toBe(
      'Для этого аккаунта ещё не задан пароль. Мы отправили в Telegram ссылку — откройте её и задайте пароль.',
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.textContent).not.toContain(tr('auth.invalidCredentials'));
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it('offers the bot when the panel could not reach it', async () => {
    appApi.login.mockRejectedValue(upstreamError(401, { code: 'PASSWORD_NOT_SET', delivery: 'bot' }));

    const page = await signInAs('imported_user', 'whatever-typed');

    expect(page.querySelector('[data-testid="signin-password-not-set"]')?.textContent).toContain(
      tr('auth.passwordNotSet.useBot'),
    );
    expect(page.querySelector('[data-testid="signin-password-not-set-bot"]')?.getAttribute('href')).toBe(
      'https://t.me/reiwa_bot?start=pwreset',
    );
  });

  it('keeps the ordinary refusal for a wrong password, and for an answer it does not know', async () => {
    for (const data of [{ message: 'Invalid username or password' }, { code: 'PASSWORD_NOT_SET', delivery: 'carrier-pigeon' }]) {
      appApi.login.mockRejectedValue(upstreamError(401, data));
      const page = await signInAs('alice', 'wrong-password');
      expect(page.querySelector('[data-testid="signin-password-not-set"]')).toBeNull();
      expect(page.querySelector('[role="alert"]')?.textContent).toBe(tr('auth.invalidCredentials'));
      await React.act(async () => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  it('has every message in both languages', async () => {
    const keys = ['sentTelegram', 'sentEmail', 'hourlyLimit', 'useBot', 'unavailable', 'openBot'];
    const russian = keys.map((key) => tr(`auth.passwordNotSet.${key}`));
    await i18n.changeLanguage('en');
    const english = keys.map((key) => tr(`auth.passwordNotSet.${key}`));
    expect(english[0]).toBe('This account has no password yet. We have sent a link to your Telegram — open it and set a password.');
    english.forEach((text, index) => expect(text, keys[index]).not.toBe(russian[index]));
  });
});

describe('/sign-in after a reset whose sign-in failed', () => {
  it('has the login typed in already, and the password field waiting', async () => {
    route.location = { pathname: '/sign-in', search: '', hash: '', state: { login: 'Alice' } };
    const page = await mount(React.createElement(SignInPage));

    expect(page.querySelector<HTMLInputElement>('input[name="username"]')?.value).toBe('Alice');
    expect(page.querySelector<HTMLInputElement>('input[name="password"]')?.value).toBe('');
  });

  it('starts empty without one, and ignores a state that is not a login', async () => {
    route.location = { pathname: '/sign-in', search: '', hash: '', state: { login: { toString: () => 'x' } } };
    const page = await mount(React.createElement(SignInPage));

    expect(page.querySelector<HTMLInputElement>('input[name="username"]')?.value).toBe('');
  });
});

// ── /recover/subscription ───────────────────────────────────────────────────

describe('/recover/subscription', () => {
  async function fillAndSend(page: HTMLElement, link: string, login: string): Promise<void> {
    await typeInto(page.querySelector('textarea'), link);
    await typeInto(page.querySelector('input[name="username"]'), login);
    await submit(page.querySelector('form'));
  }

  it('hands the token to /reset-password in memory — never in the address', async () => {
    api.recoverBySubscription.mockResolvedValue({ status: 'verified', token: TOKEN, login: 'Alice', expiresAt: 'x' });
    const page = await mount(React.createElement(RecoverSubscriptionPage));

    await fillAndSend(page, ' happ://add/https://sub.example.com/AliceShort01q ', ' alice ');

    expect(api.recoverBySubscription.mock.calls).toEqual([['happ://add/https://sub.example.com/AliceShort01q', 'alice']]);
    expect(route.navigate.mock.calls).toEqual([['/reset-password', { state: { resetToken: TOKEN, login: 'Alice' } }]]);
  });

  it('shows the recovery form’s one answer when the account has a channel, and goes nowhere', async () => {
    api.recoverBySubscription.mockResolvedValue({ status: 'accepted' });
    const page = await mount(React.createElement(RecoverSubscriptionPage));

    await fillAndSend(page, 'https://sub.example.com/AliceShort01q', 'alice');

    const sent = page.querySelector('[data-testid="recover-subscription-sent"]');
    expect(sent?.textContent).toContain(tr('auth.recover.sent'));
    expect(page.querySelector('form')).toBeNull();
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it('says up front it is for an account with no other way in, and where the link goes otherwise', async () => {
    const page = await mount(React.createElement(RecoverSubscriptionPage));
    const description = tr('auth.recoverSubscription.description');

    expect(page.textContent).toContain(description);
    expect(description).toContain('Для аккаунта без Telegram и почты');
    expect(description).toContain('ссылка для сброса придёт туда');
    expect(tr('auth.recover.noAccessBody')).toContain('Если привязаны — ссылка для сброса придёт туда');
  });

  it('shows the one failure message, whichever half was wrong', async () => {
    api.recoverBySubscription.mockRejectedValue(upstreamError(400, { code: 'NOT_VERIFIED' }));
    const page = await mount(React.createElement(RecoverSubscriptionPage));

    await fillAndSend(page, 'https://sub.example.com/Nope000001', 'alice');

    expect(page.querySelector('[data-testid="recover-subscription-error"]')?.textContent).toBe(
      'Не удалось подтвердить — проверьте ссылку и логин.',
    );
    expect(route.navigate).not.toHaveBeenCalled();
  });

  it('counts the wait in minutes, with the right plural', async () => {
    api.recoverBySubscription.mockRejectedValue(upstreamError(429, { code: 'RATE_LIMITED', retryAfter: 3600 }));
    const page = await mount(React.createElement(RecoverSubscriptionPage));

    await fillAndSend(page, 'AliceShort01q', 'alice');

    expect(page.querySelector('[data-testid="recover-subscription-error"]')?.textContent).toBe(
      'Слишком много попыток. Попробуйте через 60 минут.',
    );
  });

  it('says in advance that an encrypted Happ link will not work', async () => {
    const page = await mount(React.createElement(RecoverSubscriptionPage));
    expect(page.textContent).toContain('happ://crypt');
  });
});

// ── «Сохраните данные для входа» ────────────────────────────────────────────

describe('the save-your-details screen', () => {
  function screen(continueTo = '/dashboard') {
    return mount(React.createElement(SaveCredentialsScreen, { login: 'alice', password: 'Pa$$-w0rd<1>', continueTo }));
  }

  function clipboard(answer: 'accepts' | 'refuses', fallbackWorks: boolean) {
    const writeText = vi.fn(async (_text: string) => {
      if (answer === 'refuses') throw new DOMException('Document is not focused.', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => fallbackWorks) });
    return writeText;
  }

  it('copies the login, the password and the cabinet address — and says so only when it worked', async () => {
    const writeText = clipboard('accepts', false);
    const page = await screen();

    await press(buttonNamed(page, tr('auth.saveCredentials.copy')));

    expect(writeText.mock.calls).toEqual([
      [`Логин: alice\nПароль: Pa$$-w0rd<1>\nКабинет: ${window.location.origin}`],
    ]);
    expect(page.querySelector('[data-testid="save-credentials-notice"]')?.textContent).toBe(tr('auth.saveCredentials.copied'));

    clipboard('refuses', false);
    await press(buttonNamed(page, tr('auth.saveCredentials.copy')));
    expect(page.querySelector('[data-testid="save-credentials-notice"]')?.textContent).toBe(
      tr('auth.saveCredentials.copyFailed'),
    );
  });

  it('offers «Поделиться» only where the browser can share, and shares the details', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    let page = await screen();
    expect(page.textContent).not.toContain(tr('auth.saveCredentials.share'));
    await React.act(async () => root?.unmount());
    root = null;
    host?.remove();

    const share = vi.fn(async (_data: ShareData) => undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    page = await screen();
    await press(buttonNamed(page, tr('auth.saveCredentials.share')));
    expect(share.mock.calls).toEqual([
      [{ title: tr('auth.saveCredentials.shareTitle'), text: `Логин: alice\nПароль: Pa$$-w0rd<1>\nКабинет: ${window.location.origin}` }],
    ]);
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
  });

  it('offers «Сохранить в браузере» only with PasswordCredential, and hands the browser the pair', async () => {
    const stored: Array<{ id: string; password: string }> = [];
    // Safari and Firefox: a credentials container (for passkeys) and no
    // PasswordCredential. The button must not appear there.
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { store: vi.fn(async (credential: { id: string; password: string }) => void stored.push({ ...credential })) },
    });
    const page = await screen();
    expect(page.textContent).not.toContain(tr('auth.saveCredentials.saveInBrowser'));
    await React.act(async () => root?.unmount());
    root = null;
    host?.remove();

    class FakePasswordCredential {
      public readonly id: string;
      public readonly password: string;
      public constructor(data: { id: string; password: string }) {
        this.id = data.id;
        this.password = data.password;
      }
    }
    Object.defineProperty(window, 'PasswordCredential', { configurable: true, value: FakePasswordCredential });
    try {
      const withApi = await screen();
      await press(buttonNamed(withApi, tr('auth.saveCredentials.saveInBrowser')));
      expect(stored).toEqual([{ id: 'alice', password: 'Pa$$-w0rd<1>' }]);
      expect(withApi.querySelector('[data-testid="save-credentials-notice"]')?.textContent).toBe(
        tr('auth.saveCredentials.savedInBrowser'),
      );
    } finally {
      Reflect.deleteProperty(window, 'PasswordCredential');
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: undefined });
    }
  });

  const hints: Array<[string, string, string]> = [
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'auth.saveCredentials.hintIos'],
    ['an Android phone', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36', 'auth.saveCredentials.hintAndroid'],
    ['a Windows desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36', 'auth.saveCredentials.hintDesktop'],
  ];
  for (const [device, userAgent, key] of hints) {
    it(`gives the hint for ${device}`, async () => {
      const original = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
      try {
        const page = await screen();
        expect(page.textContent).toContain(tr(key));
      } finally {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: original });
      }
    });
  }

  it('offers to link Telegram and e-mail — only what is not linked yet, and only e-mail the server can send', async () => {
    sessionState.value = {
      session: { telegramId: null, webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    const page = await screen();
    await press(buttonNamed(page, tr('auth.saveCredentials.linkTelegram')));
    expect(route.navigate).toHaveBeenLastCalledWith('/settings/privacy?link=telegram&next=%2Fdashboard');
    await press(buttonNamed(page, tr('auth.saveCredentials.linkEmail')));
    expect(route.navigate).toHaveBeenLastCalledWith('/settings/privacy?link=email&next=%2Fdashboard');
    await React.act(async () => root?.unmount());
    root = null;
    host?.remove();

    sessionState.value = {
      session: { telegramId: '700001', webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    brandingState.value = { botUsername: 'reiwa_bot', emailEnabled: false };
    const linked = await screen();
    expect(linked.textContent).not.toContain(tr('auth.saveCredentials.linkTelegram'));
    expect(linked.textContent).not.toContain(tr('auth.saveCredentials.linkEmail'));
  });

  it('keeps where the customer was going on the detour to link Telegram, and on «Продолжить»', async () => {
    sessionState.value = {
      session: { telegramId: null, webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    const page = await screen('/renew?plan=2');

    await press(buttonNamed(page, tr('auth.saveCredentials.linkTelegram')));
    expect(route.navigate).toHaveBeenLastCalledWith('/settings/privacy?link=telegram&next=%2Frenew%3Fplan%3D2');
    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate).toHaveBeenLastCalledWith('/renew?plan=2', { replace: true });
  });

  it('carries no crafted destination along, and continues to the dashboard instead', async () => {
    sessionState.value = {
      session: { telegramId: null, webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    const page = await screen('//evil.example/phish');

    await press(buttonNamed(page, tr('auth.saveCredentials.linkTelegram')));
    expect(route.navigate).toHaveBeenLastCalledWith('/settings/privacy?link=telegram');
    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate).toHaveBeenLastCalledWith('/dashboard', { replace: true });
  });
});

// ── Privacy: «Продолжить» back to where the customer was going ──────────────

describe('privacy page reached from the save screen', () => {
  const signedIn = () => {
    sessionState.value = {
      session: { telegramId: null, webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
  };

  it('offers «Продолжить» to the carried destination', async () => {
    signedIn();
    route.location = { pathname: '/settings/privacy', search: '?next=%2Frenew', hash: '', state: null };
    const page = await mount(React.createElement(PrivacyPage));

    const button = page.querySelector<HTMLButtonElement>('[data-testid="privacy-continue"]');
    expect(button?.textContent).toBe(tr('auth.saveCredentials.continue'));
    await press(button!);
    expect(route.navigate).toHaveBeenLastCalledWith('/renew', { replace: true });
  });

  it('offers nothing without one, or with a crafted one', async () => {
    signedIn();
    route.location = { pathname: '/settings/privacy', search: '', hash: '', state: null };
    let page = await mount(React.createElement(PrivacyPage));
    expect(page.querySelector('[data-testid="privacy-continue"]')).toBeNull();
    await React.act(async () => root?.unmount());
    root = null;
    host?.remove();

    route.location = { pathname: '/settings/privacy', search: '?next=%2F%2Fevil.example', hash: '', state: null };
    page = await mount(React.createElement(PrivacyPage));
    expect(page.querySelector('[data-testid="privacy-continue"]')).toBeNull();
  });
});

// ── Registration ends on the save screen ────────────────────────────────────

describe('registration', () => {
  it('shows «Сохраните данные для входа» before the cabinet, with what was typed', async () => {
    appApi.registerUser.mockResolvedValue({ success: true, redirectUrl: '/dashboard' });
    appApi.login.mockResolvedValue({ success: true, redirectUrl: '/onboarding', requiresPasswordChange: false });
    route.location = { pathname: '/register', search: '', hash: '', state: null };
    const page = await mount(React.createElement(RegisterPage));

    const username = page.querySelector('input[name="username"]');
    const password = page.querySelector('input[name="password"]');
    expect(password?.getAttribute('autocomplete')).toBe('new-password');
    await typeInto(username, 'alice_new');
    await typeInto(password, 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(appApi.registerUser).toHaveBeenCalledTimes(1);
    expect(appApi.registerUser.mock.calls[0]?.slice(0, 2)).toEqual(['alice_new', sha256('Correct-Horse-9')]);
    expect(route.navigate).not.toHaveBeenCalled();
    expect(page.querySelector('[data-testid="saved-login"]')?.textContent).toBe('alice_new');

    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate).toHaveBeenLastCalledWith('/onboarding', { replace: true });
  });
});

// ── The other flows that set a password ─────────────────────────────────────

describe('claim and finish-setup', () => {
  const pages: Array<[string, () => unknown, string, () => void]> = [
    ['the Telegram-first claim', () => ClaimPage, '#claim-username', () => appApi.claimAccount.mockResolvedValue({ success: true })],
    ['finishing a social sign-up', () => FinishSetupPage, '#finish-username', () => appApi.finishExternalSetup.mockResolvedValue({ success: true })],
  ];
  for (const [flow, page, usernameField, succeed] of pages) {
    it(`shows the save screen after ${flow}, then goes where the customer was going`, async () => {
      window.history.replaceState({}, '', '/claim?next=%2Frenew');
      sessionState.value = {
        session: { telegramId: '700001', webAccount: null },
        isLoading: false,
        isAuthenticated: true,
      };
      succeed();
      const container = await mount(React.createElement(page()));

      await typeInto(container.querySelector(usernameField), 'new_login');
      await typeInto(container.querySelector('input[name="password"]'), 'Correct-Horse-9');
      await submit(container.querySelector('form'));

      expect(route.navigate).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="saved-login"]')?.textContent).toBe('new_login');
      await press(buttonNamed(container, tr('auth.saveCredentials.continue')));
      expect(route.navigate.mock.calls).toEqual([['/renew', { replace: true }]]);
    });
  }
});

describe('the forced password change', () => {
  it('names the account for a password manager, then shows the save screen before going on', async () => {
    window.history.replaceState({}, '', '/change-password?next=%2Frenew');
    sessionState.value = {
      session: { telegramId: null, webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    const page = await mount(React.createElement(ChangePasswordPage));

    const username = page.querySelector<HTMLInputElement>('input[name="username"]');
    expect(username?.value).toBe('alice');
    expect(username?.getAttribute('autocomplete')).toBe('username');
    expect(page.querySelector('#current-password')?.getAttribute('autocomplete')).toBe('current-password');
    expect(page.querySelector('#new-password')?.getAttribute('autocomplete')).toBe('new-password');

    await typeInto(page.querySelector('#current-password'), 'TempPass-123');
    await typeInto(page.querySelector('#new-password'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(appApi.changePasswordAuth.mock.calls).toEqual([
      [{ currentPasswordHash: sha256('TempPass-123'), newPasswordHash: sha256('Correct-Horse-9') }],
    ]);
    expect(route.navigate).not.toHaveBeenCalled();
    expect(page.querySelector('[data-testid="saved-login"]')?.textContent).toBe('alice');
    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate.mock.calls).toEqual([['/renew', { replace: true }]]);
  });
});

// ── The Mini App dead end: an account with no password yet ─────────────────

describe('the forced password page, for an account that never had a password', () => {
  // Imported without a password and signed in through the Mini App, which
  // needs none: the page asked for a current password there was no way to know.
  function importedAccount(): void {
    window.history.replaceState({}, '', '/change-password?next=%2Frenew');
    sessionState.value = {
      session: { telegramId: '700009', webAccount: { login: 'imported_user', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    securityApi.getPasswordState.mockResolvedValue({ hasPassword: false });
  }

  it('offers a first password instead of a current one, then the save screen, then on', async () => {
    importedAccount();
    securityApi.setFirstPassword.mockResolvedValue({ success: true, login: 'imported_user' });
    const page = await mount(React.createElement(ChangePasswordPage));

    expect(page.querySelector('h1')?.textContent).toBe(tr('firstPassword.title'));
    expect(page.querySelector('#current-password'), 'it still asks for a password that does not exist').toBeNull();
    expect(page.querySelector('input[name="username"]')?.getAttribute('value') ?? '').toBe('imported_user');
    expect(page.querySelector('#new-password')?.getAttribute('autocomplete')).toBe('new-password');

    await typeInto(page.querySelector('#new-password'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(securityApi.setFirstPassword.mock.calls).toEqual([[sha256('Correct-Horse-9')]]);
    expect(appApi.changePasswordAuth).not.toHaveBeenCalled();
    expect(toastSpy.success).toHaveBeenCalledWith(tr('firstPassword.success'));
    expect(page.querySelector('[data-testid="saved-login"]')?.textContent).toBe('imported_user');
    await press(buttonNamed(page, tr('auth.saveCredentials.continue')));
    expect(route.navigate.mock.calls).toEqual([['/renew', { replace: true }]]);
  });

  it('says a password was set meanwhile, and then asks for it as the current one', async () => {
    importedAccount();
    securityApi.setFirstPassword.mockRejectedValue(upstreamError(409, { code: 'PASSWORD_ALREADY_SET' }));
    const page = await mount(React.createElement(ChangePasswordPage));
    securityApi.getPasswordState.mockResolvedValue({ hasPassword: true });

    await typeInto(page.querySelector('#new-password'), 'Correct-Horse-9');
    await submit(page.querySelector('form'));

    expect(page.textContent).toContain(tr('firstPassword.errorAlreadySet'));
    expect(page.querySelector('#current-password'), 'the page kept offering to replace a password').not.toBeNull();
    expect(page.querySelector('[data-testid="saved-login"]')).toBeNull();
  });

  it('keeps the ordinary form when the panel cannot say', async () => {
    importedAccount();
    securityApi.getPasswordState.mockResolvedValue({ hasPassword: null });
    const page = await mount(React.createElement(ChangePasswordPage));

    expect(page.querySelector('h1')?.textContent).toBe(tr('changePassword.title'));
    expect(page.querySelector('#current-password')).not.toBeNull();
  });
});

// ── «Выйти на всех устройствах» ─────────────────────────────────────────────

describe('privacy: sign out on every other device', () => {
  function signedIn(webAccount: { login: string; emailVerifiedAt: null } | null): void {
    sessionState.value = { session: { telegramId: '700001', webAccount }, isLoading: false, isAuthenticated: true };
    route.location = { pathname: '/settings/privacy', search: '', hash: '', state: null };
  }

  it('asks once more, then signs every other device out and says within a minute', async () => {
    signedIn({ login: 'alice', emailVerifiedAt: null });
    securityApi.signOutOtherDevices.mockResolvedValue({ success: true });
    const page = await mount(React.createElement(PrivacyPage));

    await press(
      [...page.querySelectorAll('button')].find((button) => button.textContent?.includes(tr('signOutEverywhere.label')))!,
    );
    expect(page.textContent).toContain(tr('signOutEverywhere.body'));
    expect(securityApi.signOutOtherDevices, 'one tap on the row signed everybody out').not.toHaveBeenCalled();

    await press(buttonNamed(page, tr('signOutEverywhere.confirm')));

    expect(securityApi.signOutOtherDevices).toHaveBeenCalledTimes(1);
    expect(toastSpy.success).toHaveBeenCalledWith(tr('signOutEverywhere.done'));
  });

  it('says it is unavailable when the server cannot keep the moment for this account', async () => {
    signedIn({ login: 'alice', emailVerifiedAt: null });
    securityApi.signOutOtherDevices.mockRejectedValue(upstreamError(409, { code: 'SIGN_OUT_EVERYWHERE_UNAVAILABLE' }));
    const page = await mount(React.createElement(PrivacyPage));

    await press(
      [...page.querySelectorAll('button')].find((button) => button.textContent?.includes(tr('signOutEverywhere.label')))!,
    );
    await press(buttonNamed(page, tr('signOutEverywhere.confirm')));

    expect(toastSpy.error).toHaveBeenCalledWith(tr('signOutEverywhere.unavailable'));
  });

  it('is not offered to a Telegram-only account, which has no web login to sign out of', async () => {
    signedIn(null);
    const page = await mount(React.createElement(PrivacyPage));

    expect(page.textContent).not.toContain(tr('signOutEverywhere.label'));
  });
});

// ── The privacy dialog's password change ────────────────────────────────────

describe('privacy: change password', () => {
  it('is a real form a password manager can read, and submits with Enter', async () => {
    sessionState.value = {
      session: { telegramId: '700001', webAccount: { login: 'alice', emailVerifiedAt: null } },
      isLoading: false,
      isAuthenticated: true,
    };
    route.location = { pathname: '/settings/privacy', search: '', hash: '', state: null };
    const page = await mount(React.createElement(PrivacyPage));

    const item = [...page.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(tr('privacy.changePasswordSub')),
    );
    expect(item).toBeDefined();
    await press(item!);

    const form = page.querySelector('form');
    expect(form).not.toBeNull();
    const username = form!.querySelector<HTMLInputElement>('input[name="username"]');
    expect(username?.value).toBe('alice');
    expect(username?.getAttribute('autocomplete')).toBe('username');
    const current = form!.querySelector('input[name="current-password"]');
    const next = form!.querySelector('input[name="new-password"]');
    expect(current?.getAttribute('autocomplete')).toBe('current-password');
    expect(next?.getAttribute('autocomplete')).toBe('new-password');

    await typeInto(current, 'old-password-1');
    await typeInto(next, 'new-password-2');
    await submit(form);

    expect(appApi.changePasswordAuth.mock.calls).toEqual([
      [{ currentPasswordHash: sha256('old-password-1'), newPasswordHash: sha256('new-password-2') }],
    ]);
  });
});
