// @vitest-environment jsdom

/**
 * «Конфиденциальность»: a customer who came in through the bot has no login.
 *
 * About 99% of customers did. Linking an e-mail used to fail for them with a
 * generic error (the panel had no web account to hang the code on). It works
 * now, and once the address is confirmed the customer is OFFERED a login and a
 * password - once, declinably, without any redirect - and keeps a permanent
 * «Логин и пароль» entry for later.
 *
 * These cases drive the real `PrivacyPage` over a mocked API, with the
 * session as the panel serves it for such a customer.
 */

import { QueryClient, QueryClientProvider, defaultScheduler, notifyManager } from "@tanstack/react-query";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  changePasswordAuth: vi.fn(),
  initiateEmailLink: vi.fn(),
  initiateTelegramLink: vi.fn(),
  verifyEmailLink: vi.fn(),
  claimAccount: vi.fn(),
  finishExternalSetup: vi.fn(),
}));
const sessionState = vi.hoisted(() => ({
  session: null as unknown,
  isLoading: false,
  isAuthenticated: true,
}));

vi.mock("@/lib/api-client", () => api);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "ru", changeLanguage: vi.fn() },
  }),
}));
vi.mock("@/hooks/use-session", () => ({
  SESSION_QUERY_KEY: ["session"],
  useSession: () => sessionState,
}));
vi.mock("@/lib/branding-provider", () => ({
  useBranding: () => ({ emailEnabled: true, isLoading: false }),
}));
vi.mock("@/lib/use-legal-documents", () => ({
  useLegalDocuments: () => ({ documents: [], isLoading: false, failed: false, retry: vi.fn() }),
}));
vi.mock("@/lib/crypto", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed-password") }));
vi.mock("@/components/legal-document-dialog", () => ({ LegalDocumentDialog: () => null }));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/components/ui/network-bg", () => ({ NetworkBg: () => null }));
vi.mock("@/features/connect/platform-detect", () => ({ detectCurrentPlatform: () => "desktop" }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { readonly children: ReactNode }) => <h2>{children}</h2>,
}));

import PrivacyPage from "../src/features/settings/privacy-page";

/** The customer as the panel describes them after linking nothing: a Telegram id, no web account. */
const TELEGRAM_ONLY = { id: "u1", telegramId: "42", webAccount: null };
/** The same customer once an address is confirmed: the shell, still no login. */
const TELEGRAM_WITH_SHELL = {
  id: "u1",
  telegramId: "42",
  webAccount: {
    id: "w1",
    login: null,
    email: "me@example.com",
    emailVerifiedAt: "2026-10-01T00:00:00.000Z",
    requiresPasswordChange: false,
  },
};
/** A web-first customer. */
const WITH_LOGIN = {
  id: "u2",
  telegramId: null,
  webAccount: {
    id: "w2",
    login: "alice",
    email: null,
    emailVerifiedAt: null,
    requiresPasswordChange: false,
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let pathname = "";

function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    pathname = location.pathname;
  }, [location.pathname]);
  return null;
}

function mount(entry = "/settings/privacy"): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          <PrivacyPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

/** A page entry: its button carries the label and the sub-label together. */
function buttonContaining(fragment: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find((candidate) =>
    candidate.textContent?.includes(fragment),
  );
  if (!found) throw new Error(`no button containing "${fragment}" in: ${text()}`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function type(selector: string, value: string): void {
  const input = container?.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input matching ${selector}`);
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = container?.querySelector("form");
  if (!form) throw new Error("no form rendered");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Opens «Привязать Email», asks for a code and confirms it. */
async function linkEmailAndConfirm(): Promise<void> {
  click(button("privacy.sendVerification"));
  await settle();
}

async function typeEmailAndAskForCode(): Promise<void> {
  type('input[type="email"]', "me@example.com");
  await linkEmailAndConfirm();
}

async function enterCode(): Promise<void> {
  type('input[inputmode="numeric"]', "123456");
  click(button("common.confirm"));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  notifyManager.setScheduler(queueMicrotask);
  pathname = "";
  sessionState.session = TELEGRAM_ONLY;
  api.initiateEmailLink.mockResolvedValue({ success: true, message: "Verification code sent" });
  api.verifyEmailLink.mockResolvedValue({ success: true, verified: true });
  api.claimAccount.mockResolvedValue({ success: true, userId: "u1" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  notifyManager.setScheduler(defaultScheduler);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PrivacyPage — a customer with no login links an e-mail", () => {
  it("is offered a login and password once the address is confirmed, and can decline", async () => {
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();

    expect(text(), "the offer must follow the confirmation").toContain("privacy.setLoginOfferTitle");
    expect(button("privacy.setLoginLater")).toBeTruthy();

    click(button("privacy.setLoginLater"));
    await settle();

    // Declined: nothing is created, nothing nags, nothing redirects.
    expect(text()).not.toContain("privacy.setLoginOfferTitle");
    expect(api.claimAccount).not.toHaveBeenCalled();
    expect(pathname).toBe("/settings/privacy");
  });

  it("does not offer it again when the customer reopens the form later", async () => {
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();
    click(button("privacy.setLoginLater"));
    await settle();
    sessionState.session = TELEGRAM_WITH_SHELL;

    // Reopen through the page's own entry: it starts at the e-mail, not at the offer.
    click(buttonContaining("privacy.linkEmailSub"));
    await settle();

    // The sheet is open (it shows the confirmed address) and carries no offer.
    expect(text()).toContain("privacy.emailRelinkHint");
    expect(text()).not.toContain("privacy.setLoginOfferTitle");
  });

  it("sets the login and password from the offer, then shows them to be saved", async () => {
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();

    type("#set-login-username", "fresh-login");
    type("#set-login-password", "a-long-password");
    await submit();

    expect(api.claimAccount).toHaveBeenCalledWith("fresh-login", "hashed-password");
    expect(container?.querySelector('[data-testid="save-credentials"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="saved-login"]')?.textContent).toBe("fresh-login");
  });

  it("keeps the form up with the reason when the login is taken", async () => {
    api.claimAccount.mockRejectedValue({ response: { status: 409 } });
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();

    type("#set-login-username", "taken-login");
    type("#set-login-password", "a-long-password");
    await submit();

    expect(container?.querySelector('[role="alert"]')?.textContent).toBe("claim.errorUsernameTaken");
    expect(container?.querySelector('[data-testid="save-credentials"]')).toBeNull();
  });

  it("refuses a login or password that breaks the rules without asking the server", async () => {
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();

    type("#set-login-username", "no spaces allowed");
    type("#set-login-password", "short");
    await submit();

    expect(api.claimAccount).not.toHaveBeenCalled();
    expect(text()).toContain("claim.usernameError.invalidChars");
    expect(text()).toContain("claim.passwordError.tooShort");
  });

  it("does not offer a login to a customer who already has one", async () => {
    sessionState.session = WITH_LOGIN;
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
    await enterCode();

    expect(text()).not.toContain("privacy.setLoginOfferTitle");
    expect(api.claimAccount).not.toHaveBeenCalled();
  });
});

describe("PrivacyPage — the permanent entry", () => {
  it("offers «Логин и пароль» instead of «Сменить пароль» to a customer with no login", () => {
    for (const session of [TELEGRAM_ONLY, TELEGRAM_WITH_SHELL]) {
      sessionState.session = session;
      mount();

      expect(text()).toContain("privacy.loginPassword");
      expect(text()).not.toContain("privacy.changePassword");

      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });

  it("keeps «Сменить пароль» for a customer with a login and shows no entry for a first one", () => {
    sessionState.session = WITH_LOGIN;
    mount();

    expect(text()).toContain("privacy.changePassword");
    expect(text()).not.toContain("privacy.loginPasswordSub");
  });

  it("opens the same form from the entry, without the offer's «Не сейчас»", async () => {
    sessionState.session = TELEGRAM_WITH_SHELL;
    mount();
    click(buttonContaining("privacy.loginPasswordSub"));
    await settle();

    expect(container?.querySelector("#set-login-username")).not.toBeNull();
    expect([...(container?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "privacy.setLoginLater")).toBe(false);

    type("#set-login-username", "later-login");
    type("#set-login-password", "a-long-password");
    await submit();

    // The session shows the shell, so the call is the one every panel has always
    // accepted for a shell - not the claim of an account that does not exist.
    expect(api.finishExternalSetup).toHaveBeenCalledWith({
      username: "later-login",
      passwordHash: "hashed-password",
    });
    expect(api.claimAccount).not.toHaveBeenCalled();
  });

  it("claims for a customer with no web account at all", async () => {
    sessionState.session = TELEGRAM_ONLY;
    mount();
    click(buttonContaining("privacy.loginPasswordSub"));
    await settle();

    type("#set-login-username", "first-login");
    type("#set-login-password", "a-long-password");
    await submit();

    expect(api.claimAccount).toHaveBeenCalledWith("first-login", "hashed-password");
    expect(api.finishExternalSetup).not.toHaveBeenCalled();
  });
});

describe("PrivacyPage — what the customer is told when linking an e-mail is refused", () => {
  async function refusedWith(response: { status: number; data?: { code?: string } }): Promise<void> {
    api.initiateEmailLink.mockRejectedValue({ response });
    mount("/settings/privacy?link=email");
    await settle();
    await typeEmailAndAskForCode();
  }

  it("says the account cannot link an e-mail when the panel does not know it (the old 404)", async () => {
    await refusedWith({ status: 404, data: { code: "EMAIL_LINK_UNAVAILABLE" } });
    expect(toast.error).toHaveBeenCalledWith("privacy.emailLinkUnavailable");
  });

  it("says the address was not accepted", async () => {
    await refusedWith({ status: 400, data: { code: "EMAIL_REJECTED" } });
    expect(toast.error).toHaveBeenLastCalledWith("privacy.emailInvalid");
  });

  it("names an address another account holds", async () => {
    await refusedWith({ status: 409 });
    expect(toast.error).toHaveBeenLastCalledWith("privacy.emailAlreadyLinked");
  });

  it("names a rate limit", async () => {
    await refusedWith({ status: 429, data: { code: "EMAIL_RATE_LIMITED" } });
    expect(toast.error).toHaveBeenLastCalledWith("privacy.emailTooManyRequests");
  });

  it("falls back to the generic sentence for anything else", async () => {
    await refusedWith({ status: 500 });
    expect(toast.error).toHaveBeenLastCalledWith("privacy.linkError");
  });
});
